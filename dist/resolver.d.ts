import RpcProvider from "./rpcProvider.js";
import { AbstractResolverModule, DNSResult, ResolverOptions } from "@lumeweb/resolver-common";
export default abstract class Resolver extends AbstractResolverModule {
    protected abstract getChain(options: ResolverOptions): string;
    protected getConnection(options: ResolverOptions, bypassCache: boolean): RpcProvider;
    protected getEns(provider: RpcProvider): any;
    resolve(domain: string, options: ResolverOptions, bypassCache: boolean): Promise<DNSResult>;
    private resolve137;
}
export declare function maybeGetContentHash(contentResult: any): string | boolean;
