import { ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "http";
import { BaseNextRequest, type FetchMetric, BaseNextResponse } from ".";
import { NEXT_REQUEST_META, type RequestMeta } from "../request-meta";
import { SYMBOL_CLEARED_COOKIES, type NextApiRequestCookies } from "../api-utils";
import type { Writable } from "node:stream";
import { resolve } from "path";
import { DetachedPromise } from "../../lib/detached-promise";

type Req = Request & {
    [NEXT_REQUEST_META]?: RequestMeta
    cookies?: NextApiRequestCookies
    fetchMetrics?: FetchMetric[]
}

export class BunNextRequest extends BaseNextRequest<any> {
    public headers = (this._req.headers as any).toJSON()
    public fetchMetrics: FetchMetric[] | undefined = this._req?.fetchMetrics;

    [NEXT_REQUEST_META]: RequestMeta = this._req[NEXT_REQUEST_META] || {}

    constructor(private _req: Req) {
        super(_req.method.toUpperCase(), _req.url!, _req)
    }
    get originalRequest() {
        // Need to mimic these changes to the original req object for places where we use it:
        // render.tsx, api/ssg requests
        this._req[NEXT_REQUEST_META] = this[NEXT_REQUEST_META]
        // this._req.url = this.url - pray to god this doesn't come up
        this._req.cookies = this.cookies
        return this._req
    }
    set originalRequest(value: Req) {
        this._req = value
    }

}


// TODO: is there anyway to make the response stream
// that doesn't cause an impossible api break
export class BunNextResponse extends BaseNextResponse<WritableStream> {
    public textBody: string | undefined = undefined
    public [SYMBOL_CLEARED_COOKIES]?: boolean

    public statusCode: number = 0
    public statusMessage: string = ""
    public headers: Headers = new Headers()




    // get originalResponse() {
    //     if (SYMBOL_CLEARED_COOKIES in this) {
    //         this._res[SYMBOL_CLEARED_COOKIES] = this[SYMBOL_CLEARED_COOKIES]
    //     }

    //     return this._res
    // }

    constructor(
        // response: Response,
        public transformStream = new TransformStream(),
    ) {
        super(transformStream.writable)
        // TODO: should be able to pipe to response
        // once writer.write starts rather than on send
        // like send and end should be usefulsignas
        // const writer = transformStream.writable.getWriter()
        // writer.

    }
    setHeader(name: string, value: number | string | string[]) {
        this.headers.set(name, typeof value === "string" ? value :
            typeof value === "number" ? value.toString() :
                value.join(","))
        return this
    }
    removeHeader(name: string) {
        this.headers.delete(name)
        return this
    }
    getHeaderValues(name: string): string[] | undefined {
        const values = this.headers.get(name)
        if (values == undefined) return undefined
        return values.split(",").map(v => v.trimStart())
    }
    hasHeader(name: string) {
        return this.headers.has(name)
    }
    getHeader(name: string): string | undefined {
        return this.headers.get(name) || undefined
    }

    getHeaders() {
        // possibly should cache this is rather expensive
        const headers = (this.headers as any).toJSON() //as Record<string, string>
        for (const k in headers) {
            const split = headers[k].split(",")
            headers[k] = split.length === 1 ? split[0] : split
        }
        return headers as OutgoingHttpHeaders
    }

    appendHeader(name: string, value: string): this {
        this.headers.append(name, value)
        return this
    }

    body(value: string) {
        this.textBody = value
        return this
    }

    private readonly sendPromise = new DetachedPromise<void>()
    private _sent = false
    public send() {
        this.sendPromise.resolve()
        this._sent = true
    }
    get sent() {
        return this._sent
    }
    public async toResponse() {
        // should construct this on .write as well
        if (!this.sent) await this.sendPromise.promise

        const body = this.textBody ?? this.transformStream.readable

        let bodyInit: BodyInit = body

        return new Response(bodyInit, {
            headers: this.headers,
            status: this.statusCode,
            statusText: this.statusMessage
        })


    }

    onClose(callback: () => void): void {

    }






}