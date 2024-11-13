import { loadEnvConfig } from '@next/env'
import { APP_PATHS_MANIFEST, BUILD_ID_FILE, CLIENT_PUBLIC_FILES_PATH, MIDDLEWARE_MANIFEST, NEXT_FONT_MANIFEST, PAGES_MANIFEST, PHASE_PRODUCTION_BUILD, PRERENDER_MANIFEST, ROUTES_MANIFEST, SERVER_DIRECTORY } from '../../../api/constants'
import { INSTRUMENTATION_HOOK_FILENAME } from '../../../lib/constants'
import { getRouteMatcher } from '../../../shared/lib/router/utils/route-matcher'
import { getRouteRegex } from '../../../shared/lib/router/utils/route-regex'
import { BunNextRequest, BunNextResponse } from '../../base-http/bun'
import BaseServer, { NoFallbackError } from '../../base-server'
import type { BaseRequestHandler, FindComponentsResult, LoadedRenderOpts, MiddlewareRoutingItem, NextEnabledDirectories, NormalizedRouteManifest, Options, RequestContext, RouteHandler } from "../../base-server"
import ResponseCache from '../../response-cache'
import { IncrementalCache } from '../../lib/incremental-cache'

import { setHttpClientAndAgentOptions } from '../../setup-http-agent-env'
import path from "node:path"
import fs from "node:fs"
import * as Log from '../../../build/output/log'
import { loadManifest } from '../../load-manifest'
import type { PagesManifest } from '../../../build/webpack/plugins/pages-manifest-plugin'
import { getMaybePagePath } from '../../require'
import { findDir } from '../../../lib/find-pages-dir'
import type { ParsedUrlQuery } from 'querystring'
import { isPagesAPIRouteMatch, type PagesAPIRouteMatch } from '../../route-matches/pages-api-route-match'
import { RouteModuleLoader } from '../module-loader/route-module-loader'
import type { PagesAPIRouteModule } from '../../route-modules/pages-api/module.compiled'
import type RenderResult from '../../render-result'
import type { RenderResultMetadata } from '../../render-result'
import { formatRevalidate, type ExpireTime, type Revalidate } from '../revalidate'
import { isInterceptionRouteRewrite } from '../../../lib/generate-interception-routes-rewrites'
import { addRequestMeta, getRequestMeta, type NextParsedUrlQuery, type NextUrlWithParsedQuery } from '../../request-meta'
import type { Params } from '../../request/params'
import { BubbledError, getTracer } from '../trace/tracer'
import { NextNodeServerSpan } from '../trace/constants'
import { normalizeAppPath } from '../../../shared/lib/router/utils/app-paths'
import { PageNotFoundError, type CacheFs, MiddlewareNotFoundError, DecodeError } from '../../../shared/lib/utils'
import { normalizePagePath } from '../../../shared/lib/page-path/normalize-page-path'
import { loadComponents, type LoadComponentsReturnType } from '../../load-components'
import type { NextFontManifest } from '../../../build/webpack/plugins/next-font-manifest-plugin'
import { removeTrailingSlash } from '../../../shared/lib/router/utils/remove-trailing-slash'
import type { MatchOptions } from '../../route-matcher-managers/route-matcher-manager'
import type { RouteMatch } from '../../route-matches/route-match'
import Bun from "bun"
import { nodeFs } from '../node-fs-methods'
import { ServerResponse } from 'node:http'
import type { MiddlewareManifest } from '../../../build/webpack/plugins/middleware-plugin'
import { getMiddlewareRouteMatcher, type MiddlewareRouteMatch } from '../../../shared/lib/router/utils/middleware-route-matcher'
import { denormalizePagePath } from '../../../shared/lib/page-path/denormalize-page-path'
import { parseUrl, type ParsedUrl } from '../../../shared/lib/router/utils/parse-url'
import type { UrlWithParsedQuery } from 'node:url'
import { checkIsOnDemandRevalidate } from '../../api-utils'
import type { FetchEventResult } from '../../web/types'
import { urlQueryToSearchParams } from '../../../shared/lib/router/utils/querystring'
import { getNextPathnameInfo } from '../../../shared/lib/router/utils/get-next-pathname-info'
import { toNodeOutgoingHttpHeaders } from '../../web/utils'
import isError, { getProperError } from '../../../lib/is-error'
import { pipeToNodeResponse } from '../../pipe-readable'
import type { PrerenderManifest } from '../../../build'
import { getClonableBodyBun } from '../../body-streams'
import type { ServerOnInstrumentationRequestError } from '../../app-render/types'
import { generateETag } from '../etag'
import { sendEtagBunResponse } from '../../send-payload'
import fresh from 'next/dist/compiled/fresh'
import { RSC_CONTENT_TYPE_HEADER } from '../../../client/components/app-router-headers'
import { interopDefault } from '../../app-render/interop-default'
import { formatDynamicImportPath } from '../../../lib/format-dynamic-import-path'
import { lazyRenderAppPage } from '../../route-modules/app-page/module.render'

declare const __non_webpack_require__: NodeRequire

// For module that can be both CJS or ESM
const dynamicImportEsmDefault = process.env.NEXT_MINIMAL
    ? (id: string) =>
        import(/* webpackIgnore: true */ id).then((mod) => mod.default || mod)
    : (id: string) => import(id).then((mod) => mod.default || mod)


// For module that will be compiled to CJS, e.g. instrument
const dynamicRequire = process.env.NEXT_MINIMAL
    ? __non_webpack_require__
    : require

type BunRouteHandler = RouteHandler<BunNextRequest, BunNextResponse>
export type BunRequestHandler = BaseRequestHandler<
    // @ts-ignore
    Request | BunNextRequest,
    Response | BunNextResponse
>


const MiddlewareMatcherCache = new WeakMap<
    MiddlewareManifest['middleware'][string],
    MiddlewareRouteMatch
>()

function getMiddlewareMatcher(
    info: MiddlewareManifest['middleware'][string]
): MiddlewareRouteMatch {
    const stored = MiddlewareMatcherCache.get(info)
    if (stored) {
        return stored
    }

    if (!Array.isArray(info.matchers)) {
        throw new Error(
            `Invariant: invalid matchers for middleware ${JSON.stringify(info)}`
        )
    }

    const matcher = getMiddlewareRouteMatcher(info.matchers)
    MiddlewareMatcherCache.set(info, matcher)
    return matcher
}

export class NextBunServer extends BaseServer<
    Options,
    BunNextRequest,
    BunNextResponse> {

    protected middlewareManifestPath: string
    private _serverDistDir: string | undefined
    private imageResponseCache?: ResponseCache
    private registeredInstrumentation: boolean = false
    protected renderWorkersPromises?: Promise<void>
    protected dynamicRoutes?: {
        match: import('../../../shared/lib/router/utils/route-matcher').RouteMatchFn
        page: string
        re: RegExp
    }[]

    private routerServerHandler?: (
        req: Request,
        res: Response
    ) => void

    constructor(options: Options) {
        super(options)
        /**
         * This sets environment variable to be used at the time of SSR by head.tsx.
         * Using this from process.env allows targeting SSR by calling
         * `process.env.__NEXT_OPTIMIZE_CSS`.
         */
        if (this.renderOpts.optimizeCss) {
            process.env.__NEXT_OPTIMIZE_CSS = JSON.stringify(true)
        }
        if (this.renderOpts.nextScriptWorkers) {
            process.env.__NEXT_SCRIPT_WORKERS = JSON.stringify(true)
        }
        process.env.NEXT_DEPLOYMENT_ID = this.nextConfig.deploymentId || ''

        if (!this.minimalMode) {
            this.imageResponseCache = new ResponseCache(this.minimalMode)
        }

        const { appDocumentPreloading } = this.nextConfig.experimental
        const isDefaultEnabled = typeof appDocumentPreloading === 'undefined'

        if (!options.dev) {
            const { dynamicRoutes = [] } = this.getRoutesManifest() ?? {}
            this.dynamicRoutes = dynamicRoutes.map((r) => {
                // TODO: can we just re-use the regex from the manifest?
                const regex = getRouteRegex(r.page)
                const match = getRouteMatcher(regex)

                return {
                    match,
                    page: r.page,
                    re: regex.re,
                }
            })
        }
        // ensure options are set when loadConfig isn't called
        // setHttpClientAndAgentOptions(this.nextConfig)

        this.middlewareManifestPath = path.join(this.serverDistDir, MIDDLEWARE_MANIFEST)

        // This is just optimization to fire prepare as soon as possible. It will be
        // properly awaited later. We add the catch here to ensure that it does not
        // cause a unhandled promise rejection. The promise rejection will be
        // handled later on via the `await` when the request handler is called.
        if (!options.dev) {
            this.prepare().catch((err) => {
                console.error('Failed to prepare server', err)
            })
        }
    }
    protected async handleUpgrade(): Promise<void> {
        // The web server does not support web sockets, it's only used for HMR in
        // development.
    }
    protected async loadInstrumentationModule() {
        if (!this.serverOptions.dev) {
            try {
                this.instrumentation = await dynamicRequire(
                    path.resolve(
                        this.serverOptions.dir || '.',
                        this.serverOptions.conf.distDir!,
                        'server',
                        INSTRUMENTATION_HOOK_FILENAME
                    )
                )
            } catch (err: any) {
                if (err.code !== 'MODULE_NOT_FOUND') {
                    throw new Error(
                        'An error occurred while loading the instrumentation hook',
                        { cause: err }
                    )
                }
            }
        }
        return this.instrumentation
    }

    protected async prepareImpl() {
        await super.prepareImpl()
        await this.runInstrumentationHookIfAvailable()
    }
    protected async runInstrumentationHookIfAvailable() {
        if (this.registeredInstrumentation) return
        this.registeredInstrumentation = true
        await this.instrumentation?.register?.()
    }
    protected loadEnvConfig({
        dev,
        forceReload,
        silent,
    }: {
        dev: boolean
        forceReload?: boolean
        silent?: boolean
    }) {
        loadEnvConfig(
            this.dir,
            dev,
            silent ? { info: () => { }, error: () => { } } : Log,
            forceReload
        )
    }

    protected async getIncrementalCache({
        requestHeaders,
        requestProtocol,
    }: {
        requestHeaders: IncrementalCache['requestHeaders']
        requestProtocol: 'http' | 'https'
    }) {
        const dev = !!this.renderOpts.dev
        let CacheHandler: any
        const { cacheHandler } = this.nextConfig

        if (cacheHandler) {
            CacheHandler = interopDefault(
                await dynamicImportEsmDefault(
                    formatDynamicImportPath(this.distDir, cacheHandler)
                )
            )
        }

        const { cacheHandlers } = this.nextConfig.experimental

        if (!(globalThis as any).__nextCacheHandlers && cacheHandlers) {
            ; (globalThis as any).__nextCacheHandlers = {}

            for (const key of Object.keys(cacheHandlers)) {
                if (cacheHandlers[key]) {
                    ; (globalThis as any).__nextCacheHandlers[key] = interopDefault(
                        await dynamicImportEsmDefault(
                            formatDynamicImportPath(this.distDir, cacheHandlers[key] as any)
                        )
                    )
                }
            }
        }

        // incremental-cache is request specific
        // although can have shared caches in module scope
        // per-cache handler
        return new IncrementalCache({
            fs: this.getCacheFilesystem(),
            dev,
            requestHeaders,
            requestProtocol,
            dynamicIO: Boolean(this.nextConfig.experimental.dynamicIO),
            allowedRevalidateHeaderKeys:
                this.nextConfig.experimental.allowedRevalidateHeaderKeys,
            minimalMode: this.minimalMode,
            serverDistDir: this.serverDistDir,
            fetchCache: true,
            fetchCacheKeyPrefix: this.nextConfig.experimental.fetchCacheKeyPrefix,
            maxMemoryCacheSize: this.nextConfig.cacheMaxMemorySize,
            flushToDisk:
                !this.minimalMode && this.nextConfig.experimental.isrFlushToDisk,
            getPrerenderManifest: () => this.getPrerenderManifest(),
            CurCacheHandler: CacheHandler,
        })
    }

    protected getResponseCache() {
        return new ResponseCache(this.minimalMode)
    }
    protected getPublicDir(): string {
        return path.join(this.dir, CLIENT_PUBLIC_FILES_PATH)
    }
    protected getHasStaticDir(): boolean {
        return fs.existsSync(path.join(this.dir, 'static'))
    }

    protected getPagesManifest(): PagesManifest | undefined {
        return loadManifest(
            path.join(this.serverDistDir, PAGES_MANIFEST)
        ) as PagesManifest
    }

    protected getAppPathsManifest(): PagesManifest | undefined {
        if (!this.enabledDirectories.app) return undefined

        return loadManifest(
            path.join(this.serverDistDir, APP_PATHS_MANIFEST)
        ) as PagesManifest
    }

    protected getinterceptionRoutePatterns(): RegExp[] {
        if (!this.enabledDirectories.app) return []

        const routesManifest = this.getRoutesManifest()
        return (
            routesManifest?.rewrites.beforeFiles
                .filter(isInterceptionRouteRewrite)
                .map((rewrite) => new RegExp(rewrite.regex)) ?? []
        )
    }

    protected async hasPage(pathname: string): Promise<boolean> {
        return !!getMaybePagePath(
            pathname,
            this.distDir,
            this.nextConfig.i18n?.locales,
            this.enabledDirectories.app
        )
    }

    protected getBuildId(): string {
        const buildIdFile = path.join(this.distDir, BUILD_ID_FILE)
        try {
            return fs.readFileSync(buildIdFile, 'utf8').trim()
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw new Error(
                    `Could not find a production build in the '${this.distDir}' directory. Try building your app with 'next build' before starting the production server. https://nextjs.org/docs/messages/production-start-no-build-id`
                )
            }

            throw err
        }
    }

    protected getEnabledDirectories(dev: boolean): NextEnabledDirectories {
        const dir = dev ? this.dir : this.serverDistDir

        return {
            app: findDir(dir, 'app') ? true : false,
            pages: findDir(dir, 'pages') ? true : false,
        }
    }

    protected async sendRenderResult(
        req: BunNextRequest,
        res: BunNextResponse,
        options: {
            result: RenderResult
            type: 'html' | 'json' | 'rsc'
            generateEtags: boolean
            poweredByHeader: boolean
            revalidate: Revalidate | undefined
            expireTime: ExpireTime | undefined
        }
    ) {
        if (res.sent) {
            return
        }
        if (options.poweredByHeader && options.type === "html") {
            res.setHeader("X-Powered-By", "Next.js")
        }
        // If cache control is already set on the response we don't
        // override it to allow users to customize it via next.config
        if (typeof options.revalidate !== 'undefined' && !res.getHeader('Cache-Control')) {
            res.setHeader(
                'Cache-Control',
                formatRevalidate({
                    revalidate: options.revalidate,
                    expireTime: options.expireTime,
                })
            )
        }
        const payload = options.result.isDynamic ? null : options.result.toUnchunkedString()

        if (options.generateEtags && payload !== null) {
            const etag = generateETag(payload)
            if (sendEtagBunResponse(req, res, etag)) {
                return
            }
        }

        if (!res.getHeader('Content-Type')) {
            res.setHeader(
                'Content-Type',
                options.result.contentType
                    ? options.result.contentType
                    : options.type === 'rsc'
                        ? RSC_CONTENT_TYPE_HEADER
                        : options.type === 'json'
                            ? 'application/json'
                            : 'text/html; charset=utf-8'
            )
        }

        if (payload) {
            res.setHeader('Content-Length', Buffer.byteLength(payload))
        }

        if (req.method === 'HEAD') {
            res.send()
            return
        }

        if (payload !== null) {
            res.body(payload) // This is very wrong need a write me thod
            res.send()
            return
        }
        // piping this to node needs to be done
        // eli eli eli



    }


    protected async runApi(req: BunNextRequest, res: BunNextResponse, query: ParsedUrlQuery, match: PagesAPIRouteMatch): Promise<boolean> {
        // The module supports minimal mode, load the minimal module.
        const module = await RouteModuleLoader.load<PagesAPIRouteModule>(
            match.definition.filename
        )

        query = { ...query, ...match.params }

        delete query.__nextLocale
        delete query.__nextDefaultLocale
        delete query.__nextInferredLocaleFromDefault

        await module.render(req.originalRequest, res.originalResponse, {
            previewProps: this.renderOpts.previewProps,
            revalidate: this.revalidate.bind(this),
            trustHostHeader: this.nextConfig.experimental.trustHostHeader,
            allowedRevalidateHeaderKeys: this.nextConfig.experimental.allowedRevalidateHeaderKeys,
            hostname: this.fetchHostname,
            minimalMode: this.minimalMode,
            dev: this.renderOpts.dev === true,
            query,
            params: match.params,
            page: match.definition.pathname,
            onError: this.instrumentationOnRequestError.bind(this),
            multiZoneDraftMode: this.nextConfig.experimental.multiZoneDraftMode,
        })
        return true

    }
    protected renderHTML(
        req: BunNextRequest,
        res: BunNextResponse,
        pathname: string,
        query: NextParsedUrlQuery,
        renderOpts: LoadedRenderOpts
    ): Promise<RenderResult<RenderResultMetadata>> {

        if (process.env.NEXT_MINIMAL) {
            throw new Error(
                'Invariant: renderHTML should not be called in minimal mode'
            )
            // the `else` branch is needed for tree-shaking
        } else {
            // Due to the way we pass data by mutating `renderOpts`, we can't extend the
            // object here but only updating its `nextFontManifest` field.
            // https://github.com/vercel/next.js/blob/df7cbd904c3bd85f399d1ce90680c0ecf92d2752/packages/next/server/render.tsx#L947-L952
            renderOpts.nextFontManifest = this.nextFontManifest

            if (this.enabledDirectories.app && renderOpts.isAppPath) {
                return lazyRenderAppPage(
                    req,
                    res,
                    pathname,
                    query,
                    // This code path does not service revalidations for unknown param
                    // shells. As a result, we don't need to pass in the unknown params.
                    null,
                    renderOpts,
                    this.getServerComponentsHmrCache(),
                    false
                )
            }

            // TODO: re-enable this once we've refactored to use implicit matches
            throw new Error('Invariant: render should have used routeModule')

            // return lazyRenderPagesPage(
            //     req.originalRequest,
            //     res.originalResponse,
            //     pathname,
            //     query,
            //     renderOpts
            // )
        }


    }

    protected async renderPageComponent(ctx: RequestContext<BunNextRequest, BunNextResponse>, bubbleNoFallback: boolean) {
        return super.renderPageComponent(ctx, bubbleNoFallback)
    }


    protected async findPageComponents({
        page,
        query,
        params,
        isAppPath,
        url,
    }: {
        page: string
        query: NextParsedUrlQuery
        params: Params
        isAppPath: boolean
        // The following parameters are used in the development server's
        // implementation.
        sriEnabled?: boolean
        appPaths?: ReadonlyArray<string> | null
        shouldEnsure: boolean
        url?: string
    }): Promise<FindComponentsResult | null> {
        return getTracer().trace(
            NextNodeServerSpan.findPageComponents,
            {
                spanName: 'resolve page components',
                attributes: {
                    'next.route': isAppPath ? normalizeAppPath(page) : page,
                },
            },
            () =>
                this.findPageComponentsImpl({
                    page,
                    query,
                    params,
                    isAppPath,
                    url,
                })
        )
    }

    private async findPageComponentsImpl({
        page,
        query,
        params,
        isAppPath,
        url: _url,
    }: {
        page: string
        query: NextParsedUrlQuery
        params: Params
        isAppPath: boolean
        url?: string
    }): Promise<FindComponentsResult | null> {
        const pagePaths: string[] = [page]
        if (query.amp) {
            // try serving a static AMP version first
            pagePaths.unshift(
                (isAppPath ? normalizeAppPath(page) : normalizePagePath(page)) + '.amp'
            )
        }

        if (query.__nextLocale) {
            pagePaths.unshift(
                ...pagePaths.map(
                    (path) => `/${query.__nextLocale}${path === '/' ? '' : path}`
                )
            )
        }

        for (const pagePath of pagePaths) {
            try {
                const components = await loadComponents({
                    distDir: this.distDir,
                    page: pagePath,
                    isAppPath,
                })

                if (
                    query.__nextLocale &&
                    typeof components.Component === 'string' &&
                    !pagePath.startsWith(`/${query.__nextLocale}`)
                ) {
                    // if loading an static HTML file the locale is required
                    // to be present since all HTML files are output under their locale
                    continue
                }

                return {
                    components,
                    query: {
                        ...(!this.renderOpts.isExperimentalCompile &&
                            components.getStaticProps
                            ? ({
                                amp: query.amp,
                                __nextDataReq: query.__nextDataReq,
                                __nextLocale: query.__nextLocale,
                                __nextDefaultLocale: query.__nextDefaultLocale,
                            } as NextParsedUrlQuery)
                            : query),
                        // For appDir params is excluded.
                        ...((isAppPath ? {} : params) || {}),
                    },
                }
            } catch (err) {
                // we should only not throw if we failed to find the page
                // in the pages-manifest
                if (!(err instanceof PageNotFoundError)) {
                    throw err
                }
            }
        }
        return null
    }


    protected getNextFontManifest(): NextFontManifest | undefined {
        return loadManifest(
            path.join(this.distDir, 'server', NEXT_FONT_MANIFEST + '.json')
        ) as NextFontManifest
    }

    protected handleCatchallRenderRequest: BunRouteHandler = async (
        req,
        res,
        parsedUrl
    ) => {
        let { pathname, query } = parsedUrl
        if (!pathname) {
            throw new Error('Invariant: pathname is undefined')
        }

        // This is a catch-all route, there should be no fallbacks so mark it as
        // such.
        query._nextBubbleNoFallback = '1'

        try {
            // next.js core assumes page path without trailing slash
            pathname = removeTrailingSlash(pathname)

            const options: MatchOptions = {
                i18n: this.i18nProvider?.fromQuery(pathname, query),
            }
            const match = await this.matchers.match(pathname, options)

            // If we don't have a match, try to render it anyways.
            if (!match) {
                await this.render(req, res, pathname, query, parsedUrl, true)

                return true
            }

            // Add the match to the request so we don't have to re-run the matcher
            // for the same request.
            addRequestMeta(req, 'match', match)

            // TODO-APP: move this to a route handler
            // const edgeFunctionsPages = this.getEdgeFunctionsPages()
            // for (const edgeFunctionsPage of edgeFunctionsPages) {
            //     // If the page doesn't match the edge function page, skip it.
            //     if (edgeFunctionsPage !== match.definition.page) continue

            //     if (this.nextConfig.output === 'export') {
            //         await this.render404(req, res, parsedUrl)
            //         return true
            //     }
            //     delete query._nextBubbleNoFallback
            //     delete query[NEXT_RSC_UNION_QUERY]

            //     // If we handled the request, we can return early.
            //     // For api routes edge runtime
            //     try {
            //         const handled = await this.runEdgeFunction({
            //             req,
            //             res,
            //             query,
            //             params: match.params,
            //             page: match.definition.page,
            //             match,
            //             appPaths: null,
            //         })
            //         if (handled) return true
            //     } catch (apiError) {
            //         await this.instrumentationOnRequestError(apiError, req, {
            //             routePath: match.definition.page,
            //             routerKind: 'Pages Router',
            //             routeType: 'route',
            //             // Edge runtime does not support ISR
            //             revalidateReason: undefined,
            //         })
            //         throw apiError
            //     }
            // }

            // If the route was detected as being a Pages API route, then handle
            // it.
            // TODO: move this behavior into a route handler.
            if (isPagesAPIRouteMatch(match)) {
                if (this.nextConfig.output === 'export') {
                    await this.render404(req, res, parsedUrl)
                    return true
                }

                delete query._nextBubbleNoFallback

                const handled = await this.handleApiRequest(req, res, query, match)
                if (handled) return true
            }

            await this.render(req, res, pathname, query, parsedUrl, true)

            return true
        } catch (err: any) {
            if (err instanceof NoFallbackError) {
                throw err
            }

            try {
                if (this.renderOpts.dev) {
                    // const { formatServerError } =
                    //     require('../lib/format-server-error') as typeof import('../lib/format-server-error')
                    // formatServerError(err)
                    // await this.logErrorWithOriginalStack(err)
                } else {
                    this.logError(err)
                }
                res.statusCode = 500
                await this.renderError(err, req, res, pathname, query)
                return true
            } catch { }

            throw err
        }


    }

    // Used in development only, overloaded in next-dev-server
    protected async logErrorWithOriginalStack(
        _err?: unknown,
        _type?: 'unhandledRejection' | 'uncaughtException' | 'warning' | 'app-dir'
    ): Promise<void> {
        throw new Error(
            'Invariant: logErrorWithOriginalStack can only be called on the development server'
        )
    }
    // Used in development only, overloaded in next-dev-server
    protected async ensurePage(_opts: {
        page: string
        clientOnly: boolean
        appPaths?: ReadonlyArray<string> | null
        match?: RouteMatch
        url?: string
    }): Promise<void> {
        throw new Error(
            'Invariant: ensurePage can only be called on the development server'
        )
    }

    protected async handleApiRequest(
        req: BunNextRequest,
        res: BunNextResponse,
        query: ParsedUrlQuery,
        match: PagesAPIRouteMatch
    ) {
        return this.runApi(req, res, query, match)
    }

    protected getCacheFilesystem(): CacheFs {
        return nodeFs
    }

    protected normalizeReq(
        req: BunNextRequest | Request
    ): BunNextRequest {
        return !(req instanceof BunNextRequest) ? new BunNextRequest(req) : req
    }
    protected normalizeRes(
        res: BunNextResponse | Response
    ): BunNextResponse {
        return !(res instanceof BunNextResponse) ? new BunNextResponse(res) : res
    }

    public getRequestHandler(): BunRequestHandler {
        const handler = this.makeRequestHandler()
        if (this.serverOptions.experimentalTestProxy) {
            const {
                wrapRequestHandlerNode,
            } = require('next/dist/experimental/testmode/server')
            return wrapRequestHandlerNode(handler)
        }
        return handler
    }

    private makeRequestHandler(): BunRequestHandler {
        // This is just optimization to fire prepare as soon as possible. It will be
        // properly awaited later. We add the catch here to ensure that it does not
        // cause an unhandled promise rejection. The promise rejection will be
        // handled later on via the `await` when the request handler is called.
        this.prepare().catch((err) => {
            console.error('Failed to prepare server', err)
        })

        const handler = super.getRequestHandler()
        return (req, res, parsedUrl) =>
            handler(this.normalizeReq(req), this.normalizeRes(res), parsedUrl)

    }

    public async revalidate({
        urlPath,
        revalidateHeaders,
        opts,
    }: {
        urlPath: string
        revalidateHeaders: { [key: string]: string | string[] }
        opts: { unstable_onlyGenerated?: boolean }
    }) {
        // TODO: actually do stuff here
        const mockedResponse = new Response()

        const handler = this.getRequestHandler()
        await handler(
            new BunNextRequest(new Request("")),
            new BunNextResponse(mockedResponse)
        )

        //await mocked.res.hasStreamed

        // if (
        //     mocked.res.getHeader('x-nextjs-cache') !== 'REVALIDATED' &&
        //     !(mocked.res.statusCode === 404 && opts.unstable_onlyGenerated)
        // ) {
        //     throw new Error(`Invalid response ${mocked.res.statusCode}`)
        // }
    }

    public async render(req: BunNextRequest, res: BunNextResponse, pathname: string, query?: NextParsedUrlQuery, parsedUrl?: NextUrlWithParsedQuery | undefined, internalRender?: boolean): Promise<void> {
        return super.render(
            this.normalizeReq(req),
            this.normalizeRes(res),
            pathname,
            query,
            parsedUrl,
            internalRender
        )
    }

    public async renderToHTML(
        req: BunNextRequest | Request,
        res: BunNextResponse | Response,
        pathname: string,
        query?: ParsedUrlQuery
    ): Promise<string | null> {
        return super.renderToHTML(
            this.normalizeReq(req),
            this.normalizeRes(res),
            pathname,
            query
        )
    }

    protected async renderErrorToResponseImpl(
        ctx: RequestContext<BunNextRequest, BunNextResponse>,
        err: Error | null
    ) {
        const { req, res, query } = ctx
        const is404 = res.statusCode === 404

        if (is404 && this.enabledDirectories.app) {
            // if (this.renderOpts.dev) {
            //     await this.ensurePage({
            //         page: UNDERSCORE_NOT_FOUND_ROUTE_ENTRY,
            //         clientOnly: false,
            //         url: req.url,
            //     }).catch(() => { })
            // }

            // if (
            //     this.getEdgeFunctionsPages().includes(UNDERSCORE_NOT_FOUND_ROUTE_ENTRY)
            // ) {
            //     await this.runEdgeFunction({
            //         req,
            //         res,
            //         query: query || {},
            //         params: {},
            //         page: UNDERSCORE_NOT_FOUND_ROUTE_ENTRY,
            //         appPaths: null,
            //     })
            //     return null
            // }
        }
        return super.renderErrorToResponseImpl(ctx, err)
    }

    public async renderError(
        err: Error | null,
        req: BunNextRequest | Request,
        res: BunNextResponse | Response,
        pathname: string,
        query?: NextParsedUrlQuery,
        setHeaders?: boolean
    ): Promise<void> {
        return super.renderError(
            err,
            this.normalizeReq(req),
            this.normalizeRes(res),
            pathname,
            query,
            setHeaders
        )
    }


    public async renderErrorToHTML(
        err: Error | null,
        req: BunNextRequest | Request,
        res: BunNextResponse | Response,
        pathname: string,
        query?: ParsedUrlQuery
    ): Promise<string | null> {
        return super.renderErrorToHTML(
            err,
            this.normalizeReq(req),
            this.normalizeRes(res),
            pathname,
            query
        )
    }

    public async render404(
        req: BunNextRequest | Request,
        res: BunNextResponse | Response,
        parsedUrl?: NextUrlWithParsedQuery,
        setHeaders?: boolean
    ): Promise<void> {
        return super.render404(
            this.normalizeReq(req),
            this.normalizeRes(res),
            parsedUrl,
            setHeaders
        )
    }

    protected getMiddlewareManifest(): MiddlewareManifest | null {
        if (this.minimalMode) return null
        const manifest: MiddlewareManifest = require(this.middlewareManifestPath)
        return manifest
    }

    /** Returns the middleware routing item if there is one. */
    protected getMiddleware(): MiddlewareRoutingItem | undefined {
        const manifest = this.getMiddlewareManifest()
        const middleware = manifest?.middleware?.['/']
        if (!middleware) {
            return
        }

        return {
            match: getMiddlewareMatcher(middleware),
            page: '/',
        }
    }

    protected getEdgeFunctionsPages(): string[] {
        const manifest = this.getMiddlewareManifest()
        if (!manifest) {
            return []
        }

        return Object.keys(manifest.functions)
    }

    /**
     * Get information for the edge function located in the provided page
     * folder. If the edge function info can't be found it will throw
     * an error.
     */
    protected getEdgeFunctionInfo(params: {
        page: string
        /** Whether we should look for a middleware or not */
        middleware: boolean
    }): {
        name: string
        paths: string[]
        wasm: { filePath: string; name: string }[]
        env: { [key: string]: string }
        assets?: { filePath: string; name: string }[]
    } | null {
        const manifest = this.getMiddlewareManifest()
        if (!manifest) {
            return null
        }

        let foundPage: string

        try {
            foundPage = denormalizePagePath(normalizePagePath(params.page))
        } catch (err) {
            return null
        }

        let pageInfo = params.middleware
            ? manifest.middleware[foundPage]
            : manifest.functions[foundPage]

        if (!pageInfo) {
            if (!params.middleware) {
                throw new PageNotFoundError(foundPage)
            }
            return null
        }

        return {
            name: pageInfo.name,
            paths: pageInfo.files.map((file) => path.join(this.distDir, file)),
            wasm: (pageInfo.wasm ?? []).map((binding) => ({
                ...binding,
                filePath: path.join(this.distDir, binding.filePath),
            })),
            assets:
                pageInfo.assets &&
                pageInfo.assets.map((binding) => {
                    return {
                        ...binding,
                        filePath: path.join(this.distDir, binding.filePath),
                    }
                }),
            env: pageInfo.env,
        }
    }


    /**
     * Checks if a middleware exists. This method is useful for the development
     * server where we need to check the filesystem. Here we just check the
     * middleware manifest.
     */
    protected async hasMiddleware(pathname: string): Promise<boolean> {
        const info = this.getEdgeFunctionInfo({ page: pathname, middleware: true })
        return Boolean(info && info.paths.length > 0)
    }

    /**
     * A placeholder for a function to be defined in the development server.
     * It will make sure that the root middleware or an edge function has been compiled
     * so that we can run it.
     */
    protected async ensureMiddleware(_url?: string) { }
    protected async ensureEdgeFunction(_params: {
        page: string
        appPaths: string[] | null
        url?: string
    }) { }

    /**
     * This method gets all middleware matchers and execute them when the request
     * matches. It will make sure that each middleware exists and is compiled and
     * ready to be invoked. The development server will decorate it to add warns
     * and errors with rich traces.
     */
    protected async runMiddleware(params: {
        request: BunNextRequest
        response: BunNextResponse
        parsedUrl: ParsedUrl
        parsed: UrlWithParsedQuery
        onWarning?: (warning: Error) => void
    }) {
        if (process.env.NEXT_MINIMAL) {
            throw new Error(
                'invariant: runMiddleware should not be called in minimal mode'
            )
        }

        // Middleware is skipped for on-demand revalidate requests
        if (
            checkIsOnDemandRevalidate(params.request, this.renderOpts.previewProps)
                .isOnDemandRevalidate
        ) {
            return {
                response: new Response(null, { headers: { 'x-middleware-next': '1' } }),
            } as FetchEventResult
        }

        let url: string

        if (this.nextConfig.skipMiddlewareUrlNormalize) {
            url = getRequestMeta(params.request, 'initURL')!
        } else {
            // For middleware to "fetch" we must always provide an absolute URL
            const query = urlQueryToSearchParams(params.parsed.query).toString()
            const locale = params.parsed.query.__nextLocale

            url = `${getRequestMeta(params.request, 'initProtocol')}://${this.fetchHostname || 'localhost'
                }:${this.port}${locale ? `/${locale}` : ''}${params.parsed.pathname}${query ? `?${query}` : ''
                }`
        }

        if (!url.startsWith('http')) {
            throw new Error(
                'To use middleware you must provide a `hostname` and `port` to the Next.js Server'
            )
        }

        const page: {
            name?: string
            params?: { [key: string]: string | string[] }
        } = {}

        const middleware = this.getMiddleware()
        if (!middleware) {
            return { finished: false }
        }
        if (!(await this.hasMiddleware(middleware.page))) {
            return { finished: false }
        }

        await this.ensureMiddleware(params.request.url)
        const middlewareInfo = this.getEdgeFunctionInfo({
            page: middleware.page,
            middleware: true,
        })

        if (!middlewareInfo) {
            throw new MiddlewareNotFoundError()
        }

        const method = (params.request.method || 'GET').toUpperCase()
        const { run } = require('../../web/sandbox') as typeof import('../../web/sandbox')

        const result = await run({
            distDir: this.distDir,
            name: middlewareInfo.name,
            paths: middlewareInfo.paths,
            edgeFunctionEntry: middlewareInfo,
            request: {
                headers: params.request.headers,
                method,
                nextConfig: {
                    basePath: this.nextConfig.basePath,
                    i18n: this.nextConfig.i18n,
                    trailingSlash: this.nextConfig.trailingSlash,
                    experimental: this.nextConfig.experimental,
                },
                url: url,
                page,
                body: getRequestMeta(params.request, 'clonableBody'),
                // TODO: figure out why they attach an abort signal
                signal: new AbortSignal(),
                // signal: signalFromNodeResponse(params.response.originalResponse),
                waitUntil: this.getWaitUntil(),
            },
            useCache: true,
            onWarning: params.onWarning,
        })

        if (!this.renderOpts.dev) {
            result.waitUntil.catch((error) => {
                console.error(`Uncaught: middleware waitUntil errored`, error)
            })
        }

        if (!result) {
            this.render404(params.request, params.response, params.parsed)
            return { finished: true }
        }
        // TODO: I don't know why this is erroring
        // Split compound (comma-separated) set-cookie headers
        // if (result.response.headers.has('set-cookie')) {
        //     const cookies = result.response.headers
        //         .getSetCookie()
        //         .flatMap((maybeCompoundCookie) =>
        //             splitCookiesString(maybeCompoundCookie)
        //         )

        //     // Clear existing header(s)
        //     result.response.headers.delete('set-cookie')

        //     // Append each cookie individually.
        //     for (const cookie of cookies) {
        //         result.response.headers.append('set-cookie', cookie)
        //     }

        //     // Add cookies to request meta.
        //     addRequestMeta(params.request, 'middlewareCookie', cookies)
        // }

        return result
    }

    protected handleCatchallMiddlewareRequest: BunRouteHandler = async (
        req,
        res,
        parsed
    ) => {
        const isMiddlewareInvoke = getRequestMeta(req, 'middlewareInvoke')

        if (!isMiddlewareInvoke) {
            return false
        }

        const handleFinished = () => {
            addRequestMeta(req, 'middlewareInvoke', true)
            res.body('').send()
            return true
        }

        const middleware = this.getMiddleware()
        if (!middleware) {
            return handleFinished()
        }

        const initUrl = getRequestMeta(req, 'initURL')!
        const parsedUrl = parseUrl(initUrl)
        const pathnameInfo = getNextPathnameInfo(parsedUrl.pathname, {
            nextConfig: this.nextConfig,
            i18nProvider: this.i18nProvider,
        })

        parsedUrl.pathname = pathnameInfo.pathname
        const normalizedPathname = removeTrailingSlash(parsed.pathname || '')
        if (!middleware.match(normalizedPathname, req, parsedUrl.query)) {
            return handleFinished()
        }

        let result: Awaited<
            ReturnType<typeof NextBunServer.prototype.runMiddleware>
        >
        let bubblingResult = false

        try {
            await this.ensureMiddleware(req.url)

            result = await this.runMiddleware({
                request: req,
                response: res,
                parsedUrl: parsedUrl,
                parsed: parsed,
            })

            if ('response' in result) {
                if (isMiddlewareInvoke) {
                    bubblingResult = true
                    throw new BubbledError(true, result)
                }
                const headersJSON = (result.response.headers as any).toJSON() as Record<string, string>
                for (const [key, value] of Object.entries(
                    headersJSON
                )) {
                    if (key !== 'content-encoding' && value !== undefined) {
                        res.setHeader(key, value as string | string[])
                    }
                }
                res.statusCode = result.response.status

                // const { originalResponse } = res
                if (result.response.body) {


                    // await pipeToNodeResponse(result.response.body, originalResponse)
                    // TODO: this is really slow need to pipe this
                    // but responses are kinda immutable... prolly need to 
                    // write actual response builder api
                    res.textBody = await result.response.text()
                } else {
                    res.send()
                    // originalResponse.end()
                }
                return true
            }
        } catch (err: unknown) {
            if (bubblingResult) {
                throw err
            }

            if (isError(err) && err.code === 'ENOENT') {
                await this.render404(req, res, parsed)
                return true
            }

            if (err instanceof DecodeError) {
                res.statusCode = 400
                await this.renderError(err, req, res, parsed.pathname || '')
                return true
            }

            const error = getProperError(err)
            console.error(error)
            res.statusCode = 500
            await this.renderError(error, req, res, parsed.pathname || '')
            return true
        }

        return result.finished
    }


    private _cachedPreviewManifest: PrerenderManifest | undefined
    protected getPrerenderManifest(): PrerenderManifest {
        if (this._cachedPreviewManifest) {
            return this._cachedPreviewManifest
        }
        // if (
        //     this.renderOpts?.dev ||
        //     this.serverOptions?.dev ||
        //     process.env.NODE_ENV === 'development' ||
        //     process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD
        // ) {
        //     this._cachedPreviewManifest = {
        //         version: 4,
        //         routes: {},
        //         dynamicRoutes: {},
        //         notFoundRoutes: [],
        //         preview: {
        //             previewModeId: require('crypto').randomBytes(16).toString('hex'),
        //             previewModeSigningKey: require('crypto')
        //                 .randomBytes(32)
        //                 .toString('hex'),
        //             previewModeEncryptionKey: require('crypto')
        //                 .randomBytes(32)
        //                 .toString('hex'),
        //         },
        //     }
        //     return this._cachedPreviewManifest
        // }

        this._cachedPreviewManifest = loadManifest(
            path.join(this.distDir, PRERENDER_MANIFEST)
        ) as PrerenderManifest

        return this._cachedPreviewManifest
    }





    protected getRoutesManifest(): NormalizedRouteManifest | undefined {
        return getTracer().trace(NextNodeServerSpan.getRoutesManifest, () => {
            const manifest = loadManifest(path.join(this.distDir, ROUTES_MANIFEST)) as any

            let rewrites = manifest.rewrites ?? {
                beforeFiles: [],
                afterFiles: [],
                fallback: [],
            }

            if (Array.isArray(rewrites)) {
                rewrites = {
                    beforeFiles: [],
                    afterFiles: rewrites,
                    fallback: [],
                }
            }

            return { ...manifest, rewrites }
        })
    }




    protected attachRequestMeta(
        req: BunNextRequest,
        parsedUrl: NextUrlWithParsedQuery,
        isUpgradeReq?: boolean
    ) {
        // Injected in base-server.ts
        const protocol = req.headers['x-forwarded-proto']?.includes('https')
            ? 'https'
            : 'http'

        // When there are hostname and port we build an absolute URL
        const initUrl =
            this.fetchHostname && this.port
                ? `${protocol}://${this.fetchHostname}:${this.port}${req.url}`
                : this.nextConfig.experimental.trustHostHeader
                    ? `https://${req.headers.host || 'localhost'}${req.url}`
                    : req.url

        addRequestMeta(req, 'initURL', initUrl)
        addRequestMeta(req, 'initQuery', { ...parsedUrl.query })
        addRequestMeta(req, 'initProtocol', protocol)
        // This shouldn't be a thing - whatever
        if (!isUpgradeReq) {
            addRequestMeta(req, 'clonableBody', getClonableBodyBun(req.originalRequest))
        }
    }


    protected async runEdgeFunction(params: {
        req: BunNextRequest
        res: BunNextResponse
        query: ParsedUrlQuery
        params: Params | undefined
        page: string
        appPaths: string[] | null
        match?: RouteMatch
        onError?: (err: unknown) => void
        onWarning?: (warning: Error) => void
    }): Promise<FetchEventResult | null> {
        throw Error("no")
    }


    protected get serverDistDir(): string {
        if (this._serverDistDir) {
            return this._serverDistDir
        }
        const serverDistDir = path.join(this.distDir, SERVER_DIRECTORY)
        this._serverDistDir = serverDistDir
        return serverDistDir
    }

    protected async getFallbackErrorComponents(
        _url?: string
    ): Promise<LoadComponentsReturnType | null> {
        // Not implemented for production use cases, this is implemented on the
        // development server.
        return null
    }

    // TODO: this istilla node function
    protected async instrumentationOnRequestError(
        ...args: Parameters<ServerOnInstrumentationRequestError>
    ) {
        await super.instrumentationOnRequestError(...args)

        // For Node.js runtime production logs, in dev it will be overridden by next-dev-server
        if (!this.renderOpts.dev) {
            this.logError(args[0] as Error)
        }
    }























}