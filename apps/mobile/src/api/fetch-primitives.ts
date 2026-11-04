/** React Native's fetch classes do not expose byte streams. The shared tunnel
 * needs them, and Expo's fetch accepts a Request-like object with a stream body.
 * Keep native metadata/header behavior while owning stream consumption here. */
export function streamFetchPrimitives(BaseRequest: typeof Request, BaseResponse: typeof Response) {
  const encoder = new TextEncoder();
  const inferredType = (body: BodyInit | null | undefined): string | undefined => {
    if (typeof body === 'string') return 'text/plain;charset=UTF-8';
    if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
    if (body instanceof Blob && body.type) return body.type;
    return undefined;
  };
  const streamOf = (body: BodyInit | null | undefined): ReadableStream<Uint8Array> | null => {
    if (body == null) return null;
    if (typeof (body as ReadableStream).getReader === 'function')
      return body as ReadableStream<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // Native Blob cannot be constructed from an ArrayBuffer. Avoid that
          // conversion for binary uploads and preserve typed-array subviews.
          const bytes =
            typeof body === 'string'
              ? encoder.encode(body)
              : body instanceof ArrayBuffer
                ? new Uint8Array(body)
                : ArrayBuffer.isView(body)
                  ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
                  : body instanceof URLSearchParams
                    ? encoder.encode(body.toString())
                    : new Uint8Array(await new BaseResponse(body).arrayBuffer());
          controller.enqueue(bytes);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  };
  class Body {
    used = false;
    constructor(public stream: ReadableStream<Uint8Array> | null) {
      this.trackReader();
    }
    private trackReader() {
      const stream = this.stream;
      if (!stream) return;
      // Preserve the actual stream's internal slots while tracking consumers
      // that use body.getReader() instead of a convenience reader such as text().
      const getReader = stream.getReader.bind(stream);
      Object.defineProperty(stream, 'getReader', {
        configurable: true,
        value: () => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          const cancel = reader.cancel.bind(reader);
          reader.read = () => {
            this.used = true;
            return read();
          };
          reader.cancel = (reason?: unknown) => {
            this.used = true;
            return cancel(reason);
          };
          return reader;
        },
      });
    }
    async bytes(): Promise<ArrayBuffer> {
      if (this.used || this.stream?.locked) throw new TypeError('Body already consumed');
      if (!this.stream) return new ArrayBuffer(0);
      this.used = true;
      const reader = this.stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          length += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes.buffer;
    }
    clone(): ReadableStream<Uint8Array> | null {
      if (this.used || this.stream?.locked) throw new TypeError('Body already consumed');
      if (!this.stream) return null;
      const [original, copy] = this.stream.tee();
      this.stream = original;
      this.trackReader();
      return copy;
    }
  }
  class StreamResponse {
    readonly headers: Headers;
    readonly status: number;
    readonly statusText: string;
    readonly ok: boolean;
    readonly url = '';
    readonly redirected = false;
    readonly type = 'default';
    private readonly content: Body;
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const status = init?.status ?? 200;
      if (status < 200 || status > 599)
        throw new RangeError('Response status must be between 200 and 599');
      if (body != null && [204, 205, 304].includes(status))
        throw new TypeError('This status cannot have a body');
      const metadata = new BaseResponse(null, init);
      this.headers = metadata.headers;
      this.status = metadata.status;
      this.statusText = metadata.statusText;
      this.ok = metadata.ok;
      this.content = new Body(streamOf(body));
      const contentType = inferredType(body);
      if (contentType && !this.headers.has('content-type'))
        this.headers.set('content-type', contentType);
    }
    get [Symbol.toStringTag]() {
      return 'Response';
    }
    static json(value: unknown, init?: ResponseInit) {
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('The value cannot be serialized as JSON');
      const headers = new Headers(init?.headers);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      return new StreamResponse(text, { ...init, headers });
    }
    static redirect(url: string | URL, status = 302) {
      if (![301, 302, 303, 307, 308].includes(status))
        throw new RangeError('Invalid redirect status');
      return new StreamResponse(null, {
        status,
        headers: { location: new URL(String(url)).toString() },
      });
    }
    get body() {
      return this.content?.stream ?? null;
    }
    get bodyUsed() {
      return this.content?.used ?? false;
    }
    arrayBuffer() {
      return this.content.bytes();
    }
    async text() {
      return new TextDecoder().decode(await this.arrayBuffer());
    }
    async json() {
      return JSON.parse(await this.text()) as unknown;
    }
    async blob() {
      return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') ?? '' });
    }
    clone() {
      return new StreamResponse(this.content.clone(), {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
      });
    }
  }
  class StreamRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly credentials: RequestCredentials;
    readonly redirect: RequestRedirect;
    readonly signal: AbortSignal;
    private readonly content: Body;
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const source = input instanceof StreamRequest ? input : null;
      const native = input instanceof BaseRequest ? input : null;
      const original = source ?? native;
      const supplied = init?.body !== undefined;
      if (original?.bodyUsed && !supplied) throw new TypeError('Body already consumed');
      // Never ask the native Request constructor to consume a ReadableStream.
      const metadata = original
        ? {
            method: original.method,
            headers: original.headers,
            credentials: original.credentials,
            redirect: original.redirect,
            signal: original.signal,
            ...init,
            body: undefined,
          }
        : { ...init, body: undefined };
      const request = new BaseRequest(original ? original.url : input, metadata);
      this.url = request.url;
      this.method = request.method;
      this.headers = request.headers;
      this.credentials = request.credentials;
      this.redirect = request.redirect ?? 'follow';
      this.signal = request.signal;
      const nativeBody = native
        ? (native.body ?? (native as Request & { _bodyInit?: BodyInit })._bodyInit)
        : null;
      const rawBody = supplied ? init?.body : nativeBody;
      this.content = new Body(
        supplied ? streamOf(rawBody) : source ? source.content.clone() : streamOf(nativeBody),
      );
      if (this.content.stream && ['GET', 'HEAD'].includes(this.method.toUpperCase()))
        throw new TypeError('Body not allowed for GET or HEAD requests');
      const contentType = inferredType(rawBody);
      if (contentType && !this.headers.has('content-type'))
        this.headers.set('content-type', contentType);
    }
    get [Symbol.toStringTag]() {
      return 'Request';
    }
    get body() {
      return this.content?.stream ?? null;
    }
    get bodyUsed() {
      return this.content?.used ?? false;
    }
    arrayBuffer() {
      return this.content.bytes();
    }
    async text() {
      return new TextDecoder().decode(await this.arrayBuffer());
    }
    async json() {
      return JSON.parse(await this.text()) as unknown;
    }
    clone() {
      return new StreamRequest(this as unknown as Request);
    }
  }
  return {
    Request: StreamRequest as unknown as typeof Request,
    Response: StreamResponse as unknown as typeof Response,
  };
}
