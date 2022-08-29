import RpcProvider from "./rpcProvider.js";
// @ts-ignore
import ENSRoot, { getEnsAddress } from "@lumeweb/ensjs";
import { AbstractResolverModule, DNS_RECORD_TYPE, resolverEmptyResponse, resolverError, resolveSuccess, } from "@lumeweb/libresolver";
import pocketNetworks from "@lumeweb/pokt-rpc-endpoints";
const ENS = ENSRoot.default;
const networkMap = {
    eth: "eth-mainnet",
};
export default class Resolver extends AbstractResolverModule {
    getConnection(options, bypassCache) {
        let chain = this.getChain(options);
        if (chain in networkMap) {
            chain = networkMap[chain];
        }
        if (chain in pocketNetworks) {
            chain = pocketNetworks[chain];
        }
        return new RpcProvider(chain, this.resolver.rpcNetwork, bypassCache);
    }
    getEns(provider) {
        return new ENS({ provider, ensAddress: getEnsAddress(1) });
    }
    async resolve(domain, options, bypassCache) {
        if (!(options.options && options.options.bypassTldCheck) && this.isTldSupported(domain)) {
            return this.resolve137(domain, options, bypassCache);
        }
        return resolverEmptyResponse();
    }
    async resolve137(domain, options, bypassCache) {
        const records = [];
        const ens = options?.options?.ens ??
            this.getEns(this.getConnection(options, bypassCache));
        let name;
        try {
            name = await ens.name(domain);
        }
        catch (e) {
            return resolverError(e);
        }
        let content;
        if ([DNS_RECORD_TYPE.CONTENT, DNS_RECORD_TYPE.TEXT].includes(options.type)) {
            try {
                content = maybeGetContentHash(await name.getContent());
            }
            catch (e) {
                return resolverError(e);
            }
            records.push({
                type: DNS_RECORD_TYPE.CONTENT,
                value: content,
            });
        }
        if ([DNS_RECORD_TYPE.CUSTOM].includes(options.type)) {
            let text;
            try {
                text = await name.getText(options.customType);
            }
            catch (e) {
                return resolverError(e);
            }
            records.push({
                type: options.type,
                customType: options.customType,
                value: content,
            });
        }
        if (0 < records.length) {
            return resolveSuccess(records);
        }
        return resolverEmptyResponse();
    }
}
export function maybeGetContentHash(contentResult) {
    let content = false;
    if (typeof contentResult === "object" &&
        "contenthash" === contentResult.contentType) {
        content = contentResult.value;
    }
    return content;
}
