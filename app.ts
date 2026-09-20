import Homey from 'homey';
import http, { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import LocalApiRequestArgs from './helpers/types/LocalApiRequestArgs';
import LocalApiRequestState from './helpers/types/LocalApiRequestState';

// Methods that the HTTP API server will ever handle
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'OPTIONS'];
// Reject request bodies larger than this to avoid memory exhaustion (DoS protection)
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
// Maximum time to wait for a flow to respond before failing the request
const RESPONSE_TIMEOUT_MS = 30000;

interface JsonValidationResult {
  valid: boolean;
  data?: unknown;
  error?: string;
  normalized?: string;
}

class LocalApi extends Homey.App {

  localApiEvent: EventEmitter = new EventEmitter();
  requestReceivedArgs: Array<LocalApiRequestArgs> = [];
  server?: http.Server;
  requestCounter = 0;

  /**
   * Retrieve the CORS config from the settings
   */
  retrieveCorsConfig(): string {
    const corsAcao = this.homey.settings.get('corsAcao') || '*';
    if (corsAcao === '') {
      return '*';
    }
    return corsAcao;
  }

  /**
   * Retrieve CORS active status from the settings
   */
  isCorsActive(): boolean {
    const corsStatus = this.homey.settings.get('corsStatus') || 'true';
    return corsStatus === 'true';
  }

  /**
   * Normalize a route value so users can define routes both with and without a leading slash.
   */
  normalizeRoute(route?: string): string {
    if (!route) {
      return '/';
    }
    const trimmed = route.trim();
    if (!trimmed) {
      return '/';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  /**
   * Check if the requested url is registered by at least one flow (regardless of method)
   * @param req The node http request object
   */
  isRouteAuthorized(req: IncomingMessage): boolean {
    const normalizedRequestUrl = this.normalizeRoute(req.url);
    return this.requestReceivedArgs.find((arg: LocalApiRequestArgs) => this.normalizeRoute(arg.url) === normalizedRequestUrl) !== undefined;
  }

  /**
   * Check if the request url + method combination is registered by a flow
   * @param req The node http request object
   */
  isRouteAndMethodAuthorized(req: IncomingMessage): boolean {
    const normalizedRequestUrl = this.normalizeRoute(req.url);
    return this.requestReceivedArgs.find(
      (arg: LocalApiRequestArgs) => this.normalizeRoute(arg.url) === normalizedRequestUrl && arg.method === req.method?.toLowerCase(),
    ) !== undefined;
  }

  /**
   * Buffer the request body while enforcing a maximum size, to protect against oversized payloads.
   * @param req The node http request object
   */
  readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (e) => reject(e));
    });
  }

  /**
   * Return conservative corrections for common hand-written JSON mistakes.
   * @param raw The raw JSON string
   */
  correctJson(raw: string): string {
    let corrected = raw.trim();
    corrected = corrected.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    corrected = corrected.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    return corrected.replace(/,\s*([}\]])/g, '$1');
  }

  /**
   * Validate that a (possibly empty) string is syntactically valid JSON.
   * An empty body is considered valid (no data to validate).
   * @param raw The raw string to validate as JSON
   */
  validateJsonBody(raw: string): JsonValidationResult {
    if (!raw || raw.trim() === '') {
      return { valid: true, data: undefined };
    }
    try {
      return { valid: true, data: JSON.parse(raw) };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  }

  /**
   * Run listener for the response with 200 action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithOkRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => {
    try {
      this.localApiEvent.emit('responseAction', { status: 'ok' });
    } catch (e) {
      this.error('HTTP API: error while running "Respond with 200" action', e);
    }
    return true;
  };

  /**
   * Run listener for the response with action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithActionRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => {
    let parsedBody: unknown;

    if (typeof args.body === 'object' && args.body !== null) {
      parsedBody = args.body;
    } else if (typeof args.body === 'string') {
      const validation = this.validateJsonBody(args.body);
      if (validation.valid) {
        parsedBody = validation.data ?? {};
      } else {
        this.error(`HTTP API: "Respond with..." action received invalid JSON: ${validation.error}. Body was: ${args.body}`);
        parsedBody = { status: 'error', message: `Invalid JSON: ${validation.error}` };
      }
    } else if (args.body === undefined || args.body === null || args.body === '') {
      parsedBody = {};
    } else {
      parsedBody = args.body;
    }

    try {
      this.localApiEvent.emit('responseAction', parsedBody);
    } catch (e) {
      this.error('HTTP API: error while running "Respond with..." action', e);
    }
    return true;
  };

  /**
   * Run listener for the request received Trigger Flow Card
   * @param args The arguments passed to the trigger card
   * @param state The state of the trigger card
   */
  requestReceivedTriggerRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => (
    this.normalizeRoute(args.url) === this.normalizeRoute(state.request.url)
    && args.method === state.request.method?.toLowerCase()
  );

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // Define Trigger Requests
    const requestReceivedTrigger = this.homey.flow.getTriggerCard('local-api-request-received');
    // Define Actions Responses
    const responseWithAction = this.homey.flow.getActionCard('local-api-response-with');
    const responseWithOk = this.homey.flow.getActionCard('local-api-respond-with-200');
    // Retrieve settings and initialize the HTTP API app
    const serverPort = this.homey.settings.get('serverPort') || 3000;
    this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues() || [];
    this.localApiEvent.on('warning', (e) => this.error('HTTP API: warning', e.stack));
    this.localApiEvent.on('uncaughtException', (e) => this.error('HTTP API: uncaughtException', e.stack));
    requestReceivedTrigger.registerRunListener(this.requestReceivedTriggerRunListener);
    responseWithAction.registerRunListener(this.responseWithActionRunListener);
    responseWithOk.registerRunListener(this.responseWithOkRunListener);
    requestReceivedTrigger.on('update', async () => {
      this.log('HTTP API: found updated trigger, updating registered routes...');
      this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues();
      this.log(`HTTP API: routes updated, ${this.requestReceivedArgs.length} route(s) registered`);
    });
    this.log(`HTTP API has been initialized with ${this.requestReceivedArgs.length} route(s) registered`);

    // Create a http server instance that can be used to listening on user defined port (or 3000, default).
    this.server = http.createServer((req, res) => this.handleRequest(requestReceivedTrigger, req, res));
    this.server.listen(serverPort, () => {
      this.log(`HTTP API server started at port ${serverPort}`);
    }).on('error', (e: unknown) => {
      // Handle server error
      if (e instanceof Error) {
        if (e.message.includes('EADDRINUSE') || e.message.includes('EACCES')) {
          this.error(`HTTP API server error: port ${serverPort} already in use`);
        } else {
          this.error(`HTTP API server error: ${e.message}`);
        }
      } else {
        this.error('HTTP API server error: unknown error');
      }
    });
  }

  /**
   * Handles a single incoming HTTP request: CORS, authorization, JSON validation, flow triggering and response.
   * @param requestReceivedTrigger The trigger card used to notify flows of an incoming request
   * @param req The node http request object
   * @param res The node http response object
   */
  async handleRequest(requestReceivedTrigger: Homey.FlowCardTrigger, req: IncomingMessage, res: ServerResponse) {
    this.requestCounter += 1;
    const reqId = this.requestCounter;
    const method = (req.method || 'GET').toUpperCase();
    this.log(`HTTP API [#${reqId}]: incoming ${method} ${req.url}`);

    const corsAcao = this.retrieveCorsConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', corsAcao);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, Accept, Content-Type, Authorization, Content-Length, X-Requested-With, XMLHttpRequest');

    try {
      if (!ALLOWED_METHODS.includes(method)) {
        this.log(`HTTP API [#${reqId}]: method ${method} is not supported`);
        this.sendJson(res, 405, { status: 'error', message: `Method ${method} not allowed` });
        return;
      }

      const isPreflight = method === 'OPTIONS' && this.isCorsActive() && this.isRouteAuthorized(req) && !this.isRouteAndMethodAuthorized(req);
      if (isPreflight) {
        // Handle CORS preflight request (no matching flow explicitly listens for OPTIONS on this route)
        this.log(`HTTP API [#${reqId}]: answering CORS preflight for ${req.url}`);
        res.writeHead(200);
        res.end();
        return;
      }

      if (!this.isRouteAndMethodAuthorized(req)) {
        this.log(`HTTP API [#${reqId}]: no flow registered for ${method} ${req.url}, responding 404`);
        this.sendJson(res, 404, { status: 'not-found' });
        return;
      }

      // Read and validate the request body (only relevant for methods that can carry one)
      let rawBody = '';
      if (method === 'POST' || method === 'PUT') {
        try {
          rawBody = await this.readRequestBody(req);
        } catch (e) {
          if (e instanceof Error && e.message === 'PAYLOAD_TOO_LARGE') {
            this.error(`HTTP API [#${reqId}]: request body exceeded the ${MAX_BODY_BYTES} bytes limit`);
            this.sendJson(res, 413, { status: 'error', message: 'Request body too large' });
            return;
          }
          throw e;
        }

        const validation = this.validateJsonBody(rawBody);
        if (!validation.valid) {
          this.error(`HTTP API [#${reqId}]: invalid JSON body received: ${validation.error}`);
          this.sendJson(res, 400, { status: 'error', message: `Invalid JSON body: ${validation.error}` });
          return;
        }
      }

      this.log(`HTTP API [#${reqId}]: triggering flow(s) for ${method} ${req.url}`);
      requestReceivedTrigger.trigger(
        { url: req.url || '', method, body: rawBody },
        { request: req, response: res },
      );

      const responseData = await this.waitForFlowResponse();
      this.log(`HTTP API [#${reqId}]: flow responded, sending 200`);
      this.sendJson(res, 200, {
        status: 'success', url: req.url, method: req.method, data: responseData,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'RESPONSE_TIMEOUT') {
        this.error(`HTTP API [#${reqId}]: no response received from any flow within ${RESPONSE_TIMEOUT_MS}ms`);
        this.sendJson(res, 504, { status: 'error', message: 'Flow did not respond in time' });
      } else {
        this.error(`HTTP API [#${reqId}]: unexpected error while handling request`, e);
        this.sendJson(res, 500, { status: 'error', message: 'Internal server error' });
      }
    } finally {
      this.localApiEvent.removeAllListeners('responseAction');
    }
  }

  /**
   * Wait for a flow's "Respond with..." action, or time out after RESPONSE_TIMEOUT_MS.
   */
  waitForFlowResponse(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.localApiEvent.removeAllListeners('responseAction');
        reject(new Error('RESPONSE_TIMEOUT'));
      }, RESPONSE_TIMEOUT_MS);
      this.localApiEvent.once('responseAction', (body: unknown) => {
        clearTimeout(timeout);
        resolve(body);
      });
    });
  }

  /**
   * Write a JSON response body and end the response.
   */
  sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
    if (!res.writableEnded) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
  }

  /**
   * onUninit is called when the app is destroyed, closing the HTTP server frees the port.
   */
  async onUninit() {
    if (this.server) {
      this.log('HTTP API: closing HTTP server');
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }
  }

}

module.exports = LocalApi;
