import type { IncomingMessage, ServerResponse } from "node:http";
import url from 'node:url'
import type { StartServerOptions } from "../start-server";
import type { WorkerRequestHandler, WorkerUpgradeHandler } from "../types";
import * as Log from '../../../build/output/log'
import Bun from "next/experimental/bun/explicit-bun"
import { getNodeDebugType } from "../utils";
import { parseUrl as parseUrlUtil } from '../../../shared/lib/router/utils/parse-url'

import loadConfig from "../../config";
import {
    PHASE_PRODUCTION_SERVER,
    PHASE_DEVELOPMENT_SERVER,
    UNDERSCORE_NOT_FOUND_ROUTE,
} from '../../../shared/lib/constants'
// import type {  RenderServer } from "../router-server";
import { setupFsCheck } from "../router-utils/filesystem";
import { addRequestMeta, type NextUrlWithParsedQuery, type RequestMeta } from "../../request-meta";
import { removePathPrefix } from "../../../shared/lib/router/utils/remove-path-prefix";
import { getNextPathnameInfo } from "../../../shared/lib/router/utils/get-next-pathname-info";
import { detectDomainLocale } from "../../../client/detect-domain-locale";
import { getHostNameFromRequest, getHostname } from "../../../shared/lib/get-hostname";
import { BunNextRequest, BunNextResponse } from "../../base-http/bun";
import { type Span, trace } from '../../../trace'
import setupDebug from 'next/dist/compiled/debug'
import { getResolveRoutes } from "./resolve-routes";
import { RedirectStatusCode } from "../../../client/components/redirect-status-code";
import { NoFallbackError } from "../../base-server";
import { isAbortError } from "../../pipe-readable";
import type { LazyRenderServerInstance, RenderServer } from "./render-server";
import { DecodeError } from "../../../shared/lib/utils";

const debug = setupDebug('next:router-server:main')
const isNextFont = (pathname: string | null) =>
    pathname && /\/media\/[^/]+\.(woff|woff2|eot|ttf|otf)$/.test(pathname)

export async function startServerBun(
    serverOptions: StartServerOptions
) {
    process.title = `next-server (v${process.env.__NEXT_VERSION})`
    let handlersReady = () => { }
    let handlersError = () => { }
    let handlersPromise: Promise<void> | undefined = new Promise<void>(
        (resolve, reject) => {
            handlersReady = resolve
            handlersError = reject
        }
    )
    let requestHandler: WorkerRequestHandler = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        if (handlersPromise) {
            await handlersPromise
            return requestHandler(req, res)
        }
        throw new Error('Invariant request handler was not setup')
    }
    let upgradeHandler: WorkerUpgradeHandler = async (
        req,
        socket,
        head
    ): Promise<void> => {
        if (handlersPromise) {
            await handlersPromise
            return upgradeHandler(req, socket, head)
        }
        throw new Error('Invariant upgrade handler was not setup')
    }

    if (serverOptions.selfSignedCertificate) {
        throw new Error("Using a self signed certificate is not supported in bun")
    }

    async function requestListener(req: IncomingMessage, res: ServerResponse) {
        try {
            if (handlersPromise) {
                await handlersPromise
                handlersPromise = undefined
            }
            await requestHandler(req, res)
        } catch (err) {
            res.statusCode = 500
            res.end('Internal Server Error')
            Log.error(`Failed to handle request for ${req.url}`)
            console.error(err)
        } finally {
            // if (isDev) {
            //     if (
            //         v8.getHeapStatistics().used_heap_size >
            //         0.8 * v8.getHeapStatistics().heap_size_limit
            //     ) {
            //         Log.warn(
            //             `Server is approaching the used memory threshold, restarting...`
            //         )
            //         trace('server-restart-close-to-memory-threshold', undefined, {
            //             'memory.heapSizeLimit': String(
            //                 v8.getHeapStatistics().heap_size_limit
            //             ),
            //             'memory.heapUsed': String(v8.getHeapStatistics().used_heap_size),
            //         }).stop()
            //         await flushAllTraces()
            //         process.exit(RESTART_EXIT_CODE)
            //     }
            // }
        }
    }

    Bun.serve({
        port: serverOptions.port,
        fetch(request) {
            const response = new Response()

            // response.headers.append()

            return response
        }
    })

    // const nodeDebugType = getNodeDebugType()


}

type GetRequestHandlerOptions = {
    dir: string
    port: number
    dev: boolean
    onCleanup: (listener: () => Promise<void>) => void
    server: ReturnType<typeof Bun.serve>
    minimalMode?: boolean
    hostname?: string
    keepAliveTimeout?: number
    experimentalHttpsServer?: boolean
    startServerSpan?: Span
    quiet?: boolean
}



export async function getRequestHanlders(opts: GetRequestHandlerOptions) {
    if (!process.env.NODE_ENV) {
        (process.env.NODE_ENV as any) = opts.dev ? 'development' : 'production'
    }
    const config = await loadConfig(
        opts.dev ? PHASE_DEVELOPMENT_SERVER : PHASE_PRODUCTION_SERVER,
        opts.dir,
        { silent: false }
    )

    const fsChecker = await setupFsCheck({
        dev: opts.dev,
        dir: opts.dir,
        config,
        minimalMode: opts.minimalMode,
    })

    const renderServer: LazyRenderServerInstance = {}
    renderServer.instance = require('./render-server') as typeof import('./render-server')
    

    
    async function requestHandlerImpl(_req: Request, res: BunNextResponse) {
        const req = new BunNextRequest(_req)
        if (
            !opts.minimalMode &&
            config.i18n &&
            config.i18n.localeDetection !== false
        ) {
            const urlParts = (req.url || '').split('?', 1)
            let urlNoQuery = urlParts[0] || ''

            if (config.basePath) {
                urlNoQuery = removePathPrefix(urlNoQuery, config.basePath)
            }

            const pathnameInfo = getNextPathnameInfo(urlNoQuery, {
                nextConfig: config,
            })

            const domainLocale = detectDomainLocale(
                config.i18n.domains,
                getHostNameFromRequest({ hostname: urlNoQuery }, req.headers)
            )

            const defaultLocale =
                domainLocale?.defaultLocale || config.i18n.defaultLocale

            const { getLocaleRedirect } =
                require('../../../shared/lib/i18n/get-locale-redirect') as typeof import('../../../shared/lib/i18n/get-locale-redirect')

            const parsedUrl = parseUrlUtil((req.url || '')?.replace(/^\/+/, '/'))

            const redirect = getLocaleRedirect({
                defaultLocale,
                domainLocale,
                headers: req.headers,
                nextConfig: config,
                pathLocale: pathnameInfo.locale,
                urlParsed: {
                    ...parsedUrl,
                    pathname: pathnameInfo.locale
                        ? `/${pathnameInfo.locale}${urlNoQuery}`
                        : urlNoQuery,
                },
            })

            if (redirect) {
                res.setHeader('Location', redirect)
                res.statusCode = RedirectStatusCode.TemporaryRedirect
                res.end(redirect)
                return
            }
        }

        const invokedOutputs = new Set<string>()

        async function invokeRender(
            parsedUrl: NextUrlWithParsedQuery,
            invokePath: string,
            handleIndex: number,
            additionalRequestMeta?: RequestMeta
        ) {
            // invokeRender expects /api routes to not be locale prefixed
            // so normalize here before continuing
            if (
                config.i18n &&
                removePathPrefix(invokePath, config.basePath).startsWith(
                    `/${parsedUrl.query.__nextLocale}/api`
                )
            ) {
                invokePath = fsChecker.handleLocale(
                    removePathPrefix(invokePath, config.basePath)
                ).pathname
            }

            if (
                req.headers.get('x-nextjs-data') &&
                fsChecker.getMiddlewareMatchers()?.length &&
                removePathPrefix(invokePath, config.basePath) === '/404'
            ) {
                res.setHeader('x-nextjs-matched-path', parsedUrl.pathname || '')
                res.statusCode = 404
                res.setHeader('content-type', 'application/json')
                res.end("{}")

                return null
            }

            if (!handlers) {
                throw new Error('Failed to initialize render server')
            }

            addRequestMeta(req, 'invokePath', invokePath)
            addRequestMeta(req, 'invokeQuery', parsedUrl.query)
            addRequestMeta(req, 'middlewareInvoke', false)

            for (const key in additionalRequestMeta || {}) {
                addRequestMeta(
                    req,
                    key as keyof RequestMeta,
                    additionalRequestMeta![key as keyof RequestMeta]
                )
            }

            debug('invokeRender', req.url, req.headers)

            try {
                const initResult =
                    await renderServer?.instance?.initialize(renderServerOpts)
                try {
                    await initResult?.requestHandler(req, res)
                } catch (err) {
                    if (err instanceof NoFallbackError) {
                        // eslint-disable-next-line
                        await handleRequest(handleIndex + 1)
                        return
                    }
                    throw err
                }
                return
            } catch (e) {
                // If the client aborts before we can receive a response object (when
                // the headers are flushed), then we can early exit without further
                // processing.
                if (isAbortError(e)) {
                    return
                }
                throw e
            }


        }

        async function handleRequest(handleIndex: number) {
            if (handleIndex > 5) {
                throw new Error(`Attempted to handle request too many times ${req.url}`)
            }

            const {
                finished,
                parsedUrl,
                statusCode,
                resHeaders,
                bodyStream,
                matchedOutput,
            } = await resolveRoutes({
                req,
                res,
                isUpgradeReq: false,
                signal: new AbortSignal(), //signalFromNodeResponse(res),
                invokedOutputs,
            })

            if (res.sent) {
                return
            }
            // apply any response headers from routing
            for (const key of Object.keys(resHeaders || {})) {
                res.setHeader(key, resHeaders[key])
            }

            // handle redirect
            if (!bodyStream && statusCode && statusCode > 300 && statusCode < 400) {
                const destination = url.format(parsedUrl)
                res.statusCode = statusCode
                res.setHeader('location', destination)

                if (statusCode === RedirectStatusCode.PermanentRedirect) {
                    res.setHeader('Refresh', `0;url=${destination}`)
                }
                return res.end(destination)
            }

            // handle middleware body response
            if (bodyStream) {
                res.statusCode = statusCode || 200
                console.log("case pipeToNodeResponse")
                // return await pipeToNodeResponse(bodyStream, res)
                return
            }

            if (finished && parsedUrl.protocol) {
                console.log("case should proxy")
                return
                // return await proxyRequest(
                //     req,
                //     res,
                //     parsedUrl,
                //     undefined,
                //     getRequestMeta(req, 'clonableBody')?.cloneBodyStream(),
                //     config.experimental.proxyTimeout
                // )
            }

            if (matchedOutput?.fsPath && matchedOutput.itemPath) {
                if (
                    opts.dev &&
                    (fsChecker.appFiles.has(matchedOutput.itemPath) ||
                        fsChecker.pageFiles.has(matchedOutput.itemPath))
                ) {
                    res.statusCode = 500
                    await invokeRender(parsedUrl, '/_error', handleIndex, {
                        invokeStatus: 500,
                        invokeError: new Error(
                            `A conflicting public file and page file was found for path ${matchedOutput.itemPath} https://nextjs.org/docs/messages/conflicting-public-file-page`
                        ),
                    })
                    return
                }

                if (
                    !res.getHeader('cache-control') &&
                    matchedOutput.type === 'nextStaticFolder'
                ) {
                    if (opts.dev && !isNextFont(parsedUrl.pathname)) {
                        res.setHeader('Cache-Control', 'no-store, must-revalidate')
                    } else {
                        res.setHeader(
                            'Cache-Control',
                            'public, max-age=31536000, immutable'
                        )
                    }
                }
                if (!(req.method === 'GET' || req.method === 'HEAD')) {
                    res.setHeader('Allow', ['GET', 'HEAD'])
                    res.statusCode = 405
                    return await invokeRender(
                        url.parse('/405', true),
                        '/405',
                        handleIndex,
                        {
                            invokeStatus: 405,
                        }
                    )
                }

                try {
                    throw new Error("Didn't server static")
                    // return await serveStatic(req, res, matchedOutput.itemPath, {
                    //     root: matchedOutput.itemsRoot,
                    //     // Ensures that etags are not generated for static files when disabled.
                    //     etag: config.generateEtags,
                    // })
                } catch (err: any) {
                    /**
                     * Hardcoded every possible error status code that could be thrown by "serveStatic" method
                     * This is done by searching "this.error" inside "send" module's source code:
                     * https://github.com/pillarjs/send/blob/master/index.js
                     * https://github.com/pillarjs/send/blob/develop/index.js
                     */
                    const POSSIBLE_ERROR_CODE_FROM_SERVE_STATIC = new Set([
                        // send module will throw 500 when header is already sent or fs.stat error happens
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L392
                        // Note: we will use Next.js built-in 500 page to handle 500 errors
                        // 500,

                        // send module will throw 404 when file is missing
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L421
                        // Note: we will use Next.js built-in 404 page to handle 404 errors
                        // 404,

                        // send module will throw 403 when redirecting to a directory without enabling directory listing
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L484
                        // Note: Next.js throws a different error (without status code) for directory listing
                        // 403,

                        // send module will throw 400 when fails to normalize the path
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L520
                        400,

                        // send module will throw 412 with conditional GET request
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L632
                        412,

                        // send module will throw 416 when range is not satisfiable
                        // https://github.com/pillarjs/send/blob/53f0ab476145670a9bdd3dc722ab2fdc8d358fc6/index.js#L669
                        416,
                    ])

                    let validErrorStatus = POSSIBLE_ERROR_CODE_FROM_SERVE_STATIC.has(
                        err.statusCode
                    )

                    // normalize non-allowed status codes
                    if (!validErrorStatus) {
                        ; (err as any).statusCode = 400
                    }

                    if (typeof err.statusCode === 'number') {
                        const invokePath = `/${err.statusCode}`
                        const invokeStatus = err.statusCode
                        res.statusCode = err.statusCode
                        return await invokeRender(
                            url.parse(invokePath, true),
                            invokePath,
                            handleIndex,
                            {
                                invokeStatus,
                            }
                        )
                    }
                    throw err
                }
            }

            if (matchedOutput) {
                invokedOutputs.add(matchedOutput.itemPath)

                return await invokeRender(
                    parsedUrl,
                    parsedUrl.pathname || '/',
                    handleIndex,
                    {
                        invokeOutput: matchedOutput.itemPath,
                    }
                )
            }

            // 404 case
            res.setHeader(
                'Cache-Control',
                'private, no-cache, no-store, max-age=0, must-revalidate'
            )

            // Short-circuit favicon.ico serving so that the 404 page doesn't get built as favicon is requested by the browser when loading any route.
            if (opts.dev && !matchedOutput && parsedUrl.pathname === '/favicon.ico') {
                res.statusCode = 404
                res.end('')
                return null
            }

            const appNotFound = await fsChecker.getItem(UNDERSCORE_NOT_FOUND_ROUTE)

            res.statusCode = 404

            if (appNotFound) {
                return await invokeRender(
                    parsedUrl,
                    UNDERSCORE_NOT_FOUND_ROUTE,
                    handleIndex,
                    {
                        invokeStatus: 404,
                    }
                )
            }

            await invokeRender(parsedUrl, '/404', handleIndex, {
                invokeStatus: 404,
            })


        }

        try {
            await handleRequest(0)
        } catch (err) {
            try {
                let invokePath = '/500'
                let invokeStatus = '500'

                if (err instanceof DecodeError) {
                    invokePath = '/400'
                    invokeStatus = '400'
                } else {
                    console.error(err)
                }
                res.statusCode = Number(invokeStatus)
                return await invokeRender(url.parse(invokePath, true), invokePath, 0, {
                    invokeStatus: res.statusCode,
                })
            } catch (err2) {
                console.error(err2)
            }
            res.statusCode = 500
            res.end('Internal Server Error')
        }
    }
    const renderServerOpts: Parameters<RenderServer['initialize']>[0] = {
        port: opts.port,
        dir: opts.dir,
        hostname: opts.hostname,
        minimalMode: opts.minimalMode,
        dev: !!opts.dev,
        server: opts.server,
        serverFields: {

        },
        // experimentalTestProxy: false,
        // experimentalHttpsServer: false,
        // bundlerService: {} as any,
        // startServerSpan: opts.startServerSpan,
        quiet: false,
    }
    renderServerOpts.serverFields.routerServerHandler = requestHandlerImpl

    // pre-initialize workers
    const handlers = await renderServer.instance.initialize(renderServerOpts)
    let requestHandler = requestHandlerImpl
    const resolveRoutes = getResolveRoutes(
        fsChecker,
        config,
        opts,
        renderServer.instance,
        renderServerOpts,
    )

    return [requestHandler, handlers.app]

}