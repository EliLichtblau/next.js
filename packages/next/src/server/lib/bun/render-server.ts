import type { BunNextRequest, BunNextResponse } from "../../base-http/bun"
import { NextServer } from "./next"
import type { NextUrlWithParsedQuery } from "../../request-meta"
import type { PropagateToWorkersField } from "../router-utils/types"

export interface RequestHandler {
    (
        req: BunNextRequest,
        res: BunNextResponse,
        parsedUrl?: NextUrlWithParsedQuery | undefined
    ): Promise<void>
}

export interface LazyRenderServerInstance {
    instance?: RenderServer
}
export type RenderServer = typeof import('./render-server')

let initializations: Record<
    string,
    | Promise<{
        requestHandler: ReturnType<
            InstanceType<typeof NextServer>['getRequestHandler']
        >
        // upgradeHandler: ReturnType<
        //     InstanceType<typeof NextServer>['getUpgradeHandler']
        // >
        app: NextServer
    }>
    | undefined
> = {}

let sandboxContext: undefined | typeof import('../../web/sandbox/context')

if (process.env.NODE_ENV !== 'production') {
    sandboxContext = require('../../web/sandbox/context')
}



export function clearAllModuleContexts() {
    return sandboxContext?.clearAllModuleContexts()
}

export function clearModuleContext(target: string) {
    return sandboxContext?.clearModuleContext(target)
}

export async function getServerField(
    dir: string,
    field: PropagateToWorkersField
) {
    const initialization = await initializations[dir]
    if (!initialization) {
        throw new Error('Invariant cant propagate server field, no app initialized')
    }
    const { app } = initialization
    let appField = (app as any).server
    return appField[field]
}

export async function initializeImpl(
    opts: {
        dir: string
        port: number
        dev: boolean
        minimalMode?: boolean
        hostname?: string
        keepAliveTimeout?: number
        serverFields?: any
        server?: any
        // experimentalTestProxy: boolean
        // experimentalHttpsServer: boolean
        _ipcPort?: string
        _ipcKey?: string
        // bundlerService: DevBundlerService | undefined
        // startServerSpan: Span | undefined
        quiet?: boolean
    }
) {

    const type = process.env.__NEXT_PRIVATE_RENDER_WORKER
    if (type) {
        process.title = 'next-render-worker-' + type
    }

    let requestHandler: RequestHandler
    let upgradeHandler: any

    const app = new NextServer(opts)
    requestHandler = app.getRequestHandler()
    await app.prepare(opts.serverFields)

    return {
        requestHandler,
        app
    }

}



export async function initialize(
    opts: Parameters<typeof initializeImpl>[0]
): Promise<{
    requestHandler: ReturnType<
        InstanceType<typeof NextServer>['getRequestHandler']
    >
    // upgradeHandler: ReturnType<
    //     InstanceType<typeof NextServer>['getUpgradeHandler']
    // >
    app: NextServer
}> {
    // if we already setup the server return as we only need to do
    // this on first worker boot
    if (initializations[opts.dir]) {
        return initializations[opts.dir]!
    }
    return (initializations[opts.dir] = initializeImpl(opts))
}

