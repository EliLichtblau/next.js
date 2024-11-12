import type { IncomingMessage, ServerResponse } from "node:http";
import type { StartServerOptions } from "../start-server";
import type { WorkerRequestHandler, WorkerUpgradeHandler } from "../types";
import * as Log from '../../../build/output/log'
import Bun from "next/experimental/bun/explicit-bun"
import { getNodeDebugType } from "../utils";
import loadConfig from "../../config";
import {
    PHASE_PRODUCTION_SERVER,
    PHASE_DEVELOPMENT_SERVER,
    UNDERSCORE_NOT_FOUND_ROUTE,
} from '../../../shared/lib/constants'
import type { LazyRenderServerInstance } from "../router-server";
import { setupFsCheck } from "../router-utils/filesystem";
import type { NextUrlWithParsedQuery, RequestMeta } from "../../request-meta";
import { removePathPrefix } from "../../../shared/lib/router/utils/remove-path-prefix";




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
    renderServer.instance = require('../render-server') as typeof import('../render-server')

    async function requestHandlerImpl(request: Request, response: Response) {

  

    }

}