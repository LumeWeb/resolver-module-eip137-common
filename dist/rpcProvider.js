import * as ethers from "ethers";
import * as ethersTransactions from "@ethersproject/transactions";
import * as ethersProperties from "@ethersproject/properties";
import * as ethersBytes from "@ethersproject/bytes";
import * as ethersLogger from "@ethersproject/logger";
import * as ethersAbstractSigner from "@ethersproject/abstract-signer";
import * as ethersStrings from "@ethersproject/strings";
import { poll } from "@ethersproject/web";
import { _TypedDataEncoder } from "@ethersproject/hash";
const { defineReadOnly, resolveProperties, shallowCopy } = ethersProperties;
const { Logger } = ethersLogger;
const { toUtf8Bytes } = ethersStrings;
const { hexlify } = ethersBytes;
const allowedTransactionKeys = {
    chainId: true,
    data: true,
    gasLimit: true,
    gasPrice: true,
    nonce: true,
    to: true,
    value: true,
    type: true,
    accessList: true,
    maxFeePerGas: true,
    maxPriorityFeePerGas: true,
};
const errorGas = ["call", "estimateGas"];
function checkError(method, error, params) {
    // Undo the "convenience" some nodes are attempting to prevent backwards
    // incompatibility; maybe for v6 consider forwarding reverts as errors
    if (method === "call" &&
        error.code === ethersLogger.Logger.errors.SERVER_ERROR) {
        const e = error.error;
        if (e && e.message.match("reverted") && ethersBytes.isHexString(e.data)) {
            return e.data;
        }
        ethers.ethers.logger.throwError("missing revert data in call exception", ethersLogger.Logger.errors.CALL_EXCEPTION, {
            error,
            data: "0x",
        });
    }
    let message = error.message;
    if (error.code === ethersLogger.Logger.errors.SERVER_ERROR &&
        error.error &&
        typeof error.error.message === "string") {
        message = error.error.message;
    }
    else if (typeof error.body === "string") {
        message = error.body;
    }
    else if (typeof error.responseText === "string") {
        message = error.responseText;
    }
    message = (message || "").toLowerCase();
    const transaction = params.transaction || params.signedTransaction;
    // "insufficient funds for gas * price + value + cost(data)"
    if (message.match(/insufficient funds|base fee exceeds gas limit/)) {
        ethers.ethers.logger.throwError("insufficient funds for intrinsic transaction cost", ethersLogger.Logger.errors.INSUFFICIENT_FUNDS, {
            error,
            method,
            transaction,
        });
    }
    // "nonce too low"
    if (message.match(/nonce too low/)) {
        ethers.logger.throwError("nonce has already been used", ethersLogger.Logger.errors.NONCE_EXPIRED, {
            error,
            method,
            transaction,
        });
    }
    // "replacement transaction underpriced"
    if (message.match(/replacement transaction underpriced/)) {
        ethers.logger.throwError("replacement fee too low", ethersLogger.Logger.errors.REPLACEMENT_UNDERPRICED, {
            error,
            method,
            transaction,
        });
    }
    // "replacement transaction underpriced"
    if (message.match(/only replay-protected/)) {
        ethers.logger.throwError("legacy pre-eip-155 transactions not supported", ethersLogger.Logger.errors.UNSUPPORTED_OPERATION, {
            error,
            method,
            transaction,
        });
    }
    if (errorGas.indexOf(method) >= 0 &&
        message.match(/gas required exceeds allowance|always failing transaction|execution reverted/)) {
        ethers.logger.throwError("cannot estimate gas; transaction may fail or may require manual gas limit", ethersLogger.Logger.errors.UNPREDICTABLE_GAS_LIMIT, {
            error,
            method,
            transaction,
        });
    }
    throw error;
}
export default class RpcProvider extends ethers.providers.BaseProvider {
    constructor(dnsChain, dnsNetwork, bypassCache = false) {
        const networkOrReady = { name: "dummy", chainId: 0 };
        super(networkOrReady);
        this._dnsChain = dnsChain;
        this._rpcNetwork = dnsNetwork;
        this._bypassCache = bypassCache;
    }
    async detectNetwork() {
        return { name: "dummy", chainId: 0 };
    }
    async send(method, params) {
        const query = this._rpcNetwork.wisdomQuery(method, "evm", [this._dnsChain, ...params], this._bypassCache);
        const ret = await query.result;
        if (ret.error) {
            throw new Error(ret.error);
        }
        return ret.data;
    }
    prepareRequest(method, params) {
        switch (method) {
            case "call": {
                const hexlifyTransaction = ethers.utils.getStatic(this.constructor, "hexlifyTransaction");
                return [
                    "eth_call",
                    [
                        hexlifyTransaction(params.transaction, { from: true }),
                        params.blockTag,
                    ],
                ];
            }
            default:
                break;
        }
        return null;
    }
    async perform(method, params) {
        // Legacy networks do not like the type field being passed along (which
        // is fair), so we delete type if it is 0 and a non-EIP-1559 network
        if (method === "call") {
            const tx = params.transaction;
            if (tx && tx.type != null && ethers.BigNumber.from(tx.type).isZero()) {
                // If there are no EIP-1559 properties, it might be non-EIP-a559
                if (tx.maxFeePerGas == null && tx.maxPriorityFeePerGas == null) {
                    // Network doesn't know about EIP-1559 (and hence type)
                    params = ethersProperties.shallowCopy(params);
                    params.transaction = ethersProperties.shallowCopy(tx);
                    delete params.transaction.type;
                }
            }
        }
        const args = this.prepareRequest(method, params);
        try {
            // @ts-ignore
            return await this.send(args[0], args[1]);
        }
        catch (error) {
            return checkError(method, error, params);
        }
    }
    // Convert an ethers.js transaction into a JSON-RPC transaction
    //  - gasLimit => gas
    //  - All values hexlified
    //  - All numeric values zero-striped
    //  - All addresses are lowercased
    // NOTE: This allows a TransactionRequest, but all values should be resolved
    //       before this is called
    // @TODO: This will likely be removed in future versions and prepareRequest
    //        will be the preferred method for this.
    static hexlifyTransaction(transaction, allowExtra) {
        // Check only allowed properties are given
        const allowed = ethersProperties.shallowCopy(allowedTransactionKeys);
        if (allowExtra) {
            for (const key in allowExtra) {
                if (allowExtra[key]) {
                    allowed[key] = true;
                }
            }
        }
        const result = {};
        // Some nodes (INFURA ropsten; INFURA mainnet is fine) do not like leading zeros.
        [
            "gasLimit",
            "gasPrice",
            "type",
            "maxFeePerGas",
            "maxPriorityFeePerGas",
            "nonce",
            "value",
        ].forEach((key) => {
            if (transaction[key] == null) {
                return;
            }
            const value = ethersBytes.hexValue(transaction[key]);
            if (key === "gasLimit") {
                key = "gas";
            }
            result[key] = value;
        });
        ["from", "to", "data"].forEach((key) => {
            if (transaction[key] == null) {
                return;
            }
            result[key] = ethersBytes.hexlify(transaction[key]);
        });
        if (transaction.accessList) {
            result.accessList = ethersTransactions.accessListify(transaction.accessList);
        }
        return result;
    }
    // @ts-ignore
    getSigner(addressOrIndex) {
        // @ts-ignore
        return new RpcSigner({}, this, addressOrIndex);
    }
}
// tslint:disable-next-line:max-classes-per-file
class RpcSigner extends ethersAbstractSigner.Signer {
    // @ts-ignore
    constructor(provider, addressOrIndex) {
        super();
        // @ts-ignore
        defineReadOnly(this, "provider", provider);
        if (addressOrIndex == null) {
            addressOrIndex = 0;
        }
        if (typeof addressOrIndex === "string") {
            defineReadOnly(this, 
            // @ts-ignore
            "_address", 
            // @ts-ignore
            this.provider.formatter.address(addressOrIndex));
            // @ts-ignore
            defineReadOnly(this, "_index", null);
        }
        else if (typeof addressOrIndex === "number") {
            // @ts-ignore
            defineReadOnly(this, "_index", addressOrIndex);
            // @ts-ignore
            defineReadOnly(this, "_address", null);
        }
    }
    connect(provider) {
        return ethers.logger.throwError("cannot alter JSON-RPC Signer connection", Logger.errors.UNSUPPORTED_OPERATION, {
            operation: "connect",
        });
    }
    getAddress() {
        // @ts-ignore
        if (this._address) {
            return Promise.resolve(this._address);
        }
        return this.provider.send("eth_accounts", []).then((accounts) => {
            if (accounts.length <= this._index) {
                ethers.logger.throwError("unknown account #" + this._index, Logger.errors.UNSUPPORTED_OPERATION, {
                    operation: "getAddress",
                });
            }
            return this.provider.formatter.address(accounts[this._index]);
        });
    }
    sendUncheckedTransaction(transaction) {
        transaction = shallowCopy(transaction);
        const fromAddress = this.getAddress().then((address) => {
            if (address) {
                address = address.toLowerCase();
            }
            return address;
        });
        // The JSON-RPC for eth_sendTransaction uses 90000 gas; if the user
        // wishes to use this, it is easy to specify explicitly, otherwise
        // we look it up for them.
        if (transaction.gasLimit == null) {
            const estimate = shallowCopy(transaction);
            estimate.from = fromAddress;
            transaction.gasLimit = this.provider.estimateGas(estimate);
        }
        if (transaction.to != null) {
            // @ts-ignore
            transaction.to = Promise.resolve(transaction.to).then(async (to) => {
                if (to == null) {
                    return null;
                }
                const address = await this.provider.resolveName(to);
                if (address == null) {
                    ethers.logger.throwArgumentError("provided ENS name resolves to null", "tx.to", to);
                }
                return address;
            });
        }
        return resolveProperties({
            tx: resolveProperties(transaction),
            sender: fromAddress,
        }).then(({ tx, sender }) => {
            if (tx.from != null) {
                if (tx.from.toLowerCase() !== sender) {
                    ethers.logger.throwArgumentError("from address mismatch", "transaction", transaction);
                }
            }
            else {
                tx.from = sender;
            }
            const hexTx = this.provider.constructor.hexlifyTransaction(tx, {
                from: true,
            });
            return this.provider.send("eth_sendTransaction", [hexTx]).then((hash) => {
                return hash;
            }, (error) => {
                return checkError("sendTransaction", error, hexTx);
            });
        });
    }
    signTransaction(transaction) {
        return ethers.logger.throwError("signing transactions is unsupported", Logger.errors.UNSUPPORTED_OPERATION, {
            operation: "signTransaction",
        });
    }
    async sendTransaction(transaction) {
        // This cannot be mined any earlier than any recent block
        const blockNumber = await this.provider._getInternalBlockNumber(100 + 2 * this.provider.pollingInterval);
        // Send the transaction
        const hash = await this.sendUncheckedTransaction(transaction);
        try {
            // Unfortunately, JSON-RPC only provides and opaque transaction hash
            // for a response, and we need the actual transaction, so we poll
            // for it; it should show up very quickly
            // @ts-ignore
            return await poll(async () => {
                const tx = await this.provider.getTransaction(hash);
                if (tx === null) {
                    return undefined;
                }
                return this.provider._wrapTransaction(tx, hash, blockNumber);
            }, { oncePoll: this.provider });
        }
        catch (error) {
            error.transactionHash = hash;
            throw error;
        }
    }
    async signMessage(message) {
        const data = typeof message === "string" ? toUtf8Bytes(message) : message;
        const address = await this.getAddress();
        return this.provider.send("personal_sign", [
            hexlify(data),
            address.toLowerCase(),
        ]);
    }
    async _legacySignMessage(message) {
        const data = typeof message === "string" ? toUtf8Bytes(message) : message;
        const address = await this.getAddress();
        // https://github.com/ethereum/wiki/wiki/JSON-RPC#eth_sign
        return this.provider.send("eth_sign", [
            address.toLowerCase(),
            hexlify(data),
        ]);
    }
    async _signTypedData(domain, types, value) {
        // Populate any ENS names (in-place)
        const populated = await _TypedDataEncoder.resolveNames(domain, types, value, 
        // @ts-ignore
        (name) => {
            return this.provider.resolveName(name);
        });
        const address = await this.getAddress();
        return this.provider.send("eth_signTypedData_v4", [
            address.toLowerCase(),
            JSON.stringify(_TypedDataEncoder.getPayload(populated.domain, types, populated.value)),
        ]);
    }
    async unlock(password) {
        const provider = this.provider;
        const address = await this.getAddress();
        return provider.send("personal_unlockAccount", [
            address.toLowerCase(),
            password,
            null,
        ]);
    }
}
