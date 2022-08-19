import RpcProvider from "./rpcProvider.js";
// @ts-ignore
import ENSRoot, { getEnsAddress } from "@lumeweb/ensjs";
import {
  AbstractResolverModule,
  DNS_RECORD_TYPE,
  DNSRecord,
  resolverEmptyResponse,
  resolverError,
  resolveSuccess,
    DNSResult,
    ResolverOptions,
} from "@lumeweb/resolver-common";
import pocketNetworks from "@lumeweb/pokt-rpc-endpoints";

const ENS = ENSRoot.default;

const networkMap: { [key: string]: string } = {
  eth: "eth-mainnet",
};

export default abstract class Resolver extends AbstractResolverModule {
  protected abstract getChain(options: ResolverOptions): string;

  protected getConnection(
    options: ResolverOptions,
    bypassCache: boolean
  ): RpcProvider {
    let chain = this.getChain(options);

    if (chain in networkMap) {
      chain = networkMap[chain];
    }
    if (chain in pocketNetworks) {
      chain = pocketNetworks[chain];
    }

    return new RpcProvider(chain, this.resolver.rpcNetwork, bypassCache);
  }

  protected getEns(provider: RpcProvider): any {
    return new ENS({ provider, ensAddress: getEnsAddress(1) });
  }

  async resolve(
    domain: string,
    options: ResolverOptions,
    bypassCache: boolean
  ): Promise<DNSResult> {
    if (this.isTldSupported(domain)) {
      return this.resolve137(domain, options, bypassCache);
    }

    return resolverEmptyResponse();
  }

  private async resolve137(
    domain: string,
    options: ResolverOptions,
    bypassCache: boolean
  ): Promise<DNSResult> {
    const records: DNSRecord[] = [];

    const ens =
      options?.options?.ens ??
      this.getEns(this.getConnection(options, bypassCache));

    let name;
    try {
      name = await ens.name(domain);
    } catch (e: any) {
      return resolverError(e);
    }

    let content;
    if (
      [DNS_RECORD_TYPE.CONTENT, DNS_RECORD_TYPE.TEXT].includes(options.type)
    ) {
      try {
        content = maybeGetContentHash(await name.getContent());
      } catch (e: any) {
        return resolverError(e);
      }

      records.push({
        type: DNS_RECORD_TYPE.CONTENT,
        value: content as string,
      });
    }

    if ([DNS_RECORD_TYPE.CUSTOM].includes(options.type)) {
      let text;
      try {
        text = await name.getText(options.customType);
      } catch (e: any) {
        return resolverError(e);
      }

      records.push({
        type: options.type,
        customType: options.customType,
        value: content as string,
      });
    }

    if (0 < records.length) {
      return resolveSuccess(records);
    }

    return resolverEmptyResponse();
  }
}

export function maybeGetContentHash(contentResult: any): string | boolean {
  let content = false;

  if (
    typeof contentResult === "object" &&
    "contenthash" === contentResult.contentType
  ) {
    content = contentResult.value;
  }

  return content;
}
