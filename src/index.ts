/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  ResponseConfig,
  RouteConfig as RouteConfigBase,
  ZodMediaTypeObject,
  ZodRequestBody,
} from "@asteasolutions/zod-to-openapi";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { ZodMediaType } from "@asteasolutions/zod-to-openapi/dist/openapi-registry";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type {
  Context,
  Env,
  Handler,
  Input,
  MiddlewareHandler,
  Schema,
  ToSchema,
  TypedResponse,
  ValidationTargets as VT,
} from "hono";

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { MergePath, MergeSchemaPath } from "hono/types";

import type {
  ClientErrorStatusCode,
  InfoStatusCode,
  RedirectStatusCode,
  ServerErrorStatusCode,
  StatusCode,
  SuccessStatusCode,
} from "hono/utils/http-status";
import type {
  JSONParsed,
  JSONValue,
  RemoveBlankRecord,
  SimplifyDeepArray,
} from "hono/utils/types";
import { mergePath } from "hono/utils/url";
import type { ZodError, ZodType } from "zod";
import { z } from "zod";

type MaybePromise<T> = Promise<T> | T;

type ValidationTargets = Omit<VT, "json" | "form">;

export type RouteConfig = Omit<RouteConfigBase, "request"> & {
  request?: Omit<NonNullable<RouteConfigBase["request"]>, "body"> & {
    body?: Omit<ZodRequestBody, "content"> & {
      content: Partial<
        Record<
          ZodMediaType,
          Omit<ZodMediaTypeObject, "schema"> & { schema: ZodType<unknown> }
        >
      >;
    };
  };
  middleware?: MiddlewareHandler | MiddlewareHandler[];
  // override responses
  responses: {
    [statusCode: string]: ResponseConfig;
  };
};

type RequestTypes = NonNullable<RouteConfig["request"]>;

type ReturnJsonOrTextOrResponse<
  ContentType,
  Content,
  Status extends keyof StatusCodeRangeDefinitions | StatusCode
> = ContentType extends string
  ? ContentType extends `application/${infer Start}json${infer _End}`
    ? Start extends "" | `${string}+` | `vnd.${string}+`
      ? TypedResponse<
          SimplifyDeepArray<Content> extends JSONValue
            ? JSONValue extends SimplifyDeepArray<Content>
              ? never
              : JSONParsed<Content>
            : never,
          ExtractStatusCode<Status>,
          "json"
        >
      : never
    : ContentType extends `text/plain${infer _Rest}`
    ? TypedResponse<Content, ExtractStatusCode<Status>, "text">
    : Response
  : never;

type RequestPart<
  R extends RouteConfig,
  Part extends string
> = Part extends keyof R["request"] ? R["request"][Part] : {};

type HasUndefined<T> = undefined extends T ? true : false;

type InputTypeBase<
  R extends RouteConfig,
  Part extends string,
  Type extends keyof ValidationTargets
> = R["request"] extends RequestTypes
  ? RequestPart<R, Part> extends ZodType
    ? {
        in: {
          [K in Type]: HasUndefined<ValidationTargets[K]> extends true
            ? {
                [K2 in keyof z.input<RequestPart<R, Part>>]?: z.input<
                  RequestPart<R, Part>
                >[K2];
              }
            : {
                [K2 in keyof z.input<RequestPart<R, Part>>]: z.input<
                  RequestPart<R, Part>
                >[K2];
              };
        };
        out: { [K in Type]: z.output<RequestPart<R, Part>> };
      }
    : {}
  : {};

type InputTypeParam<R extends RouteConfig> = InputTypeBase<
  R,
  "params",
  "param"
>;
type InputTypeQuery<R extends RouteConfig> = InputTypeBase<R, "query", "query">;
type InputTypeHeader<R extends RouteConfig> = InputTypeBase<
  R,
  "headers",
  "header"
>;
type InputTypeCookie<R extends RouteConfig> = InputTypeBase<
  R,
  "cookies",
  "cookie"
>;

type ExtractContent<T> = T extends {
  [K in keyof T]: infer A;
}
  ? A extends Record<"schema", ZodType>
    ? z.infer<A["schema"]>
    : never
  : never;

type StatusCodeRangeDefinitions = {
  "1XX": InfoStatusCode;
  "2XX": SuccessStatusCode;
  "3XX": RedirectStatusCode;
  "4XX": ClientErrorStatusCode;
  "5XX": ServerErrorStatusCode;
};
type RouteConfigStatusCode = keyof StatusCodeRangeDefinitions | StatusCode;
type ExtractStatusCode<T extends RouteConfigStatusCode> =
  T extends keyof StatusCodeRangeDefinitions
    ? StatusCodeRangeDefinitions[T]
    : T;
type DefinedStatusCodes<R extends RouteConfig> = keyof R["responses"] &
  RouteConfigStatusCode;

export type RouteConfigToTypedResponse<R extends RouteConfig> =
  | {
      [Status in DefinedStatusCodes<R>]: undefined extends R["responses"][Status]["content"]
        ? TypedResponse<{}, ExtractStatusCode<Status>, string>
        : ReturnJsonOrTextOrResponse<
            keyof R["responses"][Status]["content"],
            ExtractContent<R["responses"][Status]["content"]>,
            Status
          >;
    }[DefinedStatusCodes<R>]
  | ("default" extends keyof R["responses"]
      ? undefined extends R["responses"]["default"]["content"]
        ? TypedResponse<
            {},
            Exclude<StatusCode, ExtractStatusCode<DefinedStatusCodes<R>>>,
            string
          >
        : ReturnJsonOrTextOrResponse<
            keyof R["responses"]["default"]["content"],
            ExtractContent<R["responses"]["default"]["content"]>,
            Exclude<StatusCode, ExtractStatusCode<DefinedStatusCodes<R>>>
          >
      : never);

export type Hook<T, E extends Env, P extends string, R> = (
  result: { target: keyof ValidationTargets } & (
    | {
        success: true;
        data: T;
      }
    | {
        success: false;
        error: ZodError;
      }
  ),
  c: Context<E, P>
) => R;

type ConvertPathType<T extends string> =
  T extends `${infer Start}/{${infer Param}}${infer Rest}`
    ? `${Start}/:${Param}${ConvertPathType<Rest>}`
    : T;

export type OpenAPIHonoOptions<E extends Env> = {
  defaultHook?: Hook<any, E, any, any>;
};
type HonoInit<E extends Env> = ConstructorParameters<typeof Hono>[0] &
  OpenAPIHonoOptions<E>;

/**
 * Turns `T | T[] | undefined` into `T[]`
 */
type AsArray<T> = T extends undefined // TODO move to utils?
  ? []
  : T extends any[]
  ? T
  : [T];

/**
 * Like simplify but recursive
 */
export type DeepSimplify<T> = {
  // TODO move to utils?
  [KeyType in keyof T]: T[KeyType] extends Record<string, unknown>
    ? DeepSimplify<T[KeyType]>
    : T[KeyType];
} & {};

/**
 * Helper to infer generics from {@link MiddlewareHandler}
 */
export type OfHandlerType<T extends MiddlewareHandler> =
  T extends MiddlewareHandler<infer E, infer P, infer I>
    ? {
        env: E;
        path: P;
        input: I;
      }
    : never;

/**
 * Reduce a tuple of middleware handlers into a single
 * handler representing the composition of all
 * handlers.
 */
export type MiddlewareToHandlerType<
  M extends MiddlewareHandler<any, any, any>[]
> = M extends [infer First, infer Second, ...infer Rest]
  ? First extends MiddlewareHandler<any, any, any>
    ? Second extends MiddlewareHandler<any, any, any>
      ? Rest extends MiddlewareHandler<any, any, any>[] // Ensure Rest is an array of MiddlewareHandler
        ? MiddlewareToHandlerType<
            [
              MiddlewareHandler<
                DeepSimplify<
                  OfHandlerType<First>["env"] & OfHandlerType<Second>["env"]
                >, // Combine envs
                OfHandlerType<First>["path"], // Keep path from First
                OfHandlerType<First>["input"] // Keep input from First
              >,
              ...Rest
            ]
          >
        : never
      : never
    : never
  : M extends [infer Last]
  ? Last // Return the last remaining handler in the array
  : never;

type RouteMiddlewareParams<R extends RouteConfig> = OfHandlerType<
  MiddlewareToHandlerType<AsArray<R["middleware"]>>
>;

type BodyValidationMiddlewareEnv<R extends RouteConfig> = {
  Variables: {
    validatedBody: {
      [K in keyof NonNullable<NonNullable<R["request"]>["body"]>["content"]]: {
        mediaType: K;
        data: z.infer<
          NonNullable<NonNullable<R["request"]>["body"]>["content"][K] extends {
            schema: ZodType<unknown>;
          }
            ? NonNullable<
                NonNullable<R["request"]>["body"]
              >["content"][K]["schema"]
            : never
        >;
      };
    }[keyof NonNullable<NonNullable<R["request"]>["body"]>["content"]];
  };
};

export type RouteConfigToEnv<R extends RouteConfig> =
  (RouteMiddlewareParams<R> extends never
    ? Env
    : RouteMiddlewareParams<R>["env"]) &
    BodyValidationMiddlewareEnv<R>;

export type RouteHandler<
  R extends RouteConfig,
  E extends Env = RouteConfigToEnv<R>,
  I extends Input = InputTypeParam<R> &
    InputTypeQuery<R> &
    InputTypeHeader<R> &
    InputTypeCookie<R>,
  P extends string = ConvertPathType<R["path"]>
> = Handler<
  E,
  P,
  I,
  // If response type is defined, only TypedResponse is allowed.
  R extends {
    responses: {
      [statusCode: number]: {
        content: {
          [mediaType: string]: ZodMediaTypeObject;
        };
      };
    };
  }
    ? MaybePromise<RouteConfigToTypedResponse<R>>
    : MaybePromise<RouteConfigToTypedResponse<R>> | MaybePromise<Response>
>;

export type RouteHook<
  R extends RouteConfig,
  E extends Env = RouteConfigToEnv<R>,
  I extends Input = InputTypeParam<R> &
    InputTypeQuery<R> &
    InputTypeHeader<R> &
    InputTypeCookie<R>,
  P extends string = ConvertPathType<R["path"]>
> = Hook<
  I,
  E,
  P,
  | RouteConfigToTypedResponse<R>
  | Response
  | Promise<Response>
  | void
  | Promise<void>
>;

type OpenAPIObjectConfig = Parameters<
  InstanceType<typeof OpenApiGeneratorV3>["generateDocument"]
>[0];

export type OpenAPIObjectConfigure<E extends Env, P extends string> =
  | OpenAPIObjectConfig
  | ((context: Context<E, P>) => OpenAPIObjectConfig);

const JSON_CONTENT_TYPE_REGEX =
  /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/;
const MULTIPART_FORM_CONTENT_TYPE_REGEX =
  /^multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?$/;
const URL_ENCODED_FORM_CONTENT_TYPE_REGEX =
  /^application\/x-www-form-urlencoded(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/;

export class OpenAPIHono<
  E extends Env = Env,
  S extends Schema = {},
  BasePath extends string = "/"
> extends Hono<E, S, BasePath> {
  openAPIRegistry: OpenAPIRegistry;
  defaultHook?: OpenAPIHonoOptions<E>["defaultHook"];

  constructor(init?: HonoInit<E>) {
    super(init);
    this.openAPIRegistry = new OpenAPIRegistry();
    this.defaultHook = init?.defaultHook;
  }

  /**
   *
   * @param {RouteConfig} route - The route definition which you create with `createRoute()`.
   * @param {Handler} handler - The handler. If you want to return a JSON object, you should specify the status code with `c.json()`.
   * @param {Hook} hook - Optional. The hook method defines what it should do after validation.
   * @example
   * app.openapi(
   *   route,
   *   (c) => {
   *     // ...
   *     return c.json(
   *       {
   *         age: 20,
   *         name: 'Young man',
   *       },
   *       200 // You should specify the status code even if it's 200.
   *     )
   *   },
   *  (result, c) => {
   *    if (!result.success) {
   *      return c.json(
   *        {
   *          code: 400,
   *          message: 'Custom Message',
   *        },
   *        400
   *      )
   *    }
   *  }
   *)
   */

  openapi = <
    R extends RouteConfig,
    I extends Input = InputTypeParam<R> &
      InputTypeQuery<R> &
      InputTypeHeader<R> &
      InputTypeCookie<R>,
    P extends string = ConvertPathType<R["path"]>
  >(
    { middleware: routeMiddleware, ...route }: R,
    handler: Handler<
      // use the env from the middleware if it's defined
      (R["middleware"] extends MiddlewareHandler[] | MiddlewareHandler
        ? RouteMiddlewareParams<R>["env"] & E
        : E) &
        BodyValidationMiddlewareEnv<R>,
      P,
      I,
      // If response type is defined, only TypedResponse is allowed.
      R extends {
        responses: {
          [statusCode: number]: {
            content: {
              [mediaType: string]: ZodMediaTypeObject;
            };
          };
        };
      }
        ? MaybePromise<RouteConfigToTypedResponse<R>>
        : MaybePromise<RouteConfigToTypedResponse<R>> | MaybePromise<Response>
    >,
    hook:
      | Hook<
          I,
          E,
          P,
          R extends {
            responses: {
              [statusCode: number]: {
                content: {
                  [mediaType: string]: ZodMediaTypeObject;
                };
              };
            };
          }
            ? MaybePromise<RouteConfigToTypedResponse<R>> | undefined
            :
                | MaybePromise<RouteConfigToTypedResponse<R>>
                | MaybePromise<Response>
                | undefined
        >
      | undefined = this.defaultHook
  ): OpenAPIHono<
    E,
    S &
      ToSchema<
        R["method"],
        MergePath<BasePath, P>,
        I,
        RouteConfigToTypedResponse<R>
      >,
    BasePath
  > => {
    this.openAPIRegistry.registerPath(route as RouteConfig);

    const validators: MiddlewareHandler[] = [];

    if (route.request?.query) {
      const validator = zValidator(
        "query",
        route.request.query as any,
        hook as any
      );
      validators.push(validator as any);
    }

    if (route.request?.params) {
      const validator = zValidator(
        "param",
        route.request.params as any,
        hook as any
      );
      validators.push(validator as any);
    }

    if (route.request?.headers) {
      const validator = zValidator(
        "header",
        route.request.headers as any,
        hook as any
      );
      validators.push(validator as any);
    }

    if (route.request?.cookies) {
      const validator = zValidator(
        "cookie",
        route.request.cookies as any,
        hook as any
      );
      validators.push(validator as any);
    }

    const bodyContent = route.request?.body?.content;

    const bodyValidationMiddleware = createMiddleware(async (c, next) => {
      if (!bodyContent) {
        await next();
        return;
      }

      const contentType = c.req.header("content-type");

      if (!contentType) {
        throw new HTTPException(400, {
          message: "Missing Content-Type header.",
        });
      }

      const mediaType = contentType.split(";")[0]!.trim();
      const schema = bodyContent[mediaType]?.schema;

      if (!schema) {
        throw new HTTPException(415, {
          message: `Unsupported Content-Type: ${contentType}`,
        });
      }

      let value;

      switch (true) {
        case JSON_CONTENT_TYPE_REGEX.test(mediaType):
          try {
            value = await c.req.json();
          } catch {
            const message = `Malformed ${mediaType} request.`;
            throw new HTTPException(400, { message });
          }
          break;
        case MULTIPART_FORM_CONTENT_TYPE_REGEX.test(mediaType) ||
          URL_ENCODED_FORM_CONTENT_TYPE_REGEX.test(mediaType): {
          try {
            value = await c.req.parseBody();
          } catch (e) {
            throw new HTTPException(400, {
              message: `Malformed ${mediaType} request.`,
            });
          }
          break;
        }
        default:
          value = c.req.raw.clone().body;
      }

      /* START: excerpt from zValidator */

      const result = await schema.safeParseAsync(value);
      if (!result.success) {
        return c.json(result, 400);
      }

      c.set("validatedBody", {
        mediaType: mediaType,
        data: result.data,
      });

      //} as BodyValidationMiddlewareEnv<R>["Variables"]["validatedBody"]);
      /* END: excerpt from zValidator */

      await next();
      return;
    });

    const middleware = routeMiddleware
      ? Array.isArray(routeMiddleware)
        ? routeMiddleware
        : [routeMiddleware]
      : [];

    const h: Handler = handler;

    this.on(
      [route.method],
      route.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
      ...middleware,
      ...validators,
      bodyValidationMiddleware,
      h
    );
    return this;
  };

  private getOpenAPIDocument = (
    config: OpenAPIObjectConfig
  ): ReturnType<typeof generator.generateDocument> => {
    const generator = new OpenApiGeneratorV3(this.openAPIRegistry.definitions);
    const document = generator.generateDocument(config);
    // @ts-expect-error the _basePath is a private property
    return this._basePath
      ? // @ts-expect-error the _basePath is a private property
        addBasePathToDocument(document, this._basePath)
      : document;
  };

  private getOpenAPI31Document = (
    config: OpenAPIObjectConfig
  ): ReturnType<typeof generator.generateDocument> => {
    const generator = new OpenApiGeneratorV31(this.openAPIRegistry.definitions);
    const document = generator.generateDocument(config);
    // @ts-expect-error the _basePath is a private property
    return this._basePath
      ? // @ts-expect-error the _basePath is a private property
        addBasePathToDocument(document, this._basePath)
      : document;
  };

  doc = <P extends string>(
    path: P,
    configure: OpenAPIObjectConfigure<E, P>
  ): OpenAPIHono<E, S & ToSchema<"get", P, {}, {}>, BasePath> => {
    return this.get(path, (c) => {
      const config = typeof configure === "function" ? configure(c) : configure;
      try {
        const document = this.getOpenAPIDocument(config);
        return c.json(document);
      } catch (e: any) {
        return c.json(e, 500);
      }
    }) as any;
  };

  doc31 = <P extends string>(
    path: P,
    configure: OpenAPIObjectConfigure<E, P>
  ): OpenAPIHono<E, S & ToSchema<"get", P, {}, {}>, BasePath> => {
    return this.get(path, (c) => {
      const config = typeof configure === "function" ? configure(c) : configure;
      try {
        const document = this.getOpenAPI31Document(config);
        return c.json(document);
      } catch (e: any) {
        return c.json(e, 500);
      }
    }) as any;
  };

  override route<
    SubPath extends string,
    SubEnv extends Env,
    SubSchema extends Schema,
    SubBasePath extends string
  >(
    path: SubPath,
    app: Hono<SubEnv, SubSchema, SubBasePath>
  ): OpenAPIHono<
    E,
    MergeSchemaPath<SubSchema, MergePath<BasePath, SubPath>> & S,
    BasePath
  >;
  override route<SubPath extends string>(
    path: SubPath
  ): Hono<E, RemoveBlankRecord<S>, BasePath>;
  override route<
    SubPath extends string,
    SubEnv extends Env,
    SubSchema extends Schema,
    SubBasePath extends string
  >(
    path: SubPath,
    app?: Hono<SubEnv, SubSchema, SubBasePath>
  ): OpenAPIHono<
    E,
    MergeSchemaPath<SubSchema, MergePath<BasePath, SubPath>> & S,
    BasePath
  > {
    const pathForOpenAPI = path.replaceAll(/:([^\/]+)/g, "{$1}");
    super.route(path, app as any);

    if (!(app instanceof OpenAPIHono)) {
      return this as any;
    }

    app.openAPIRegistry.definitions.forEach((def) => {
      switch (def.type) {
        case "component":
          return this.openAPIRegistry.registerComponent(
            def.componentType,
            def.name,
            def.component
          );

        case "route":
          return this.openAPIRegistry.registerPath({
            ...def.route,
            path: mergePath(pathForOpenAPI, def.route.path),
          });

        case "webhook":
          return this.openAPIRegistry.registerWebhook({
            ...def.webhook,
            path: mergePath(pathForOpenAPI, def.webhook.path),
          });

        case "schema":
          return this.openAPIRegistry.register(
            def.schema._def.openapi._internal.refId,
            def.schema
          );

        case "parameter":
          return this.openAPIRegistry.registerParameter(
            def.schema._def.openapi._internal.refId,
            def.schema
          );

        default: {
          const errorIfNotExhaustive: never = def;
          throw new Error(`Unknown registry type: ${errorIfNotExhaustive}`);
        }
      }
    });

    return this as any;
  }

  override basePath<SubPath extends string>(
    path: SubPath
  ): OpenAPIHono<E, S, MergePath<BasePath, SubPath>> {
    return new OpenAPIHono({
      ...(super.basePath(path) as any),
      defaultHook: this.defaultHook,
    });
  }
}

type RoutingPath<P extends string> =
  P extends `${infer Head}/{${infer Param}}${infer Tail}`
    ? `${Head}/:${Param}${RoutingPath<Tail>}`
    : P;

export const createRoute = <
  P extends string,
  R extends Omit<RouteConfig, "path"> & { path: P }
>(
  routeConfig: R
) => {
  const route = {
    ...routeConfig,
    getRoutingPath(): RoutingPath<R["path"]> {
      return routeConfig.path.replaceAll(
        /\/{(.+?)}/g,
        "/:$1"
      ) as RoutingPath<P>;
    },
  };
  return Object.defineProperty(route, "getRoutingPath", { enumerable: false });
};

extendZodWithOpenApi(z);
export { extendZodWithOpenApi, z };

function addBasePathToDocument(
  document: Record<string, any>,
  basePath: string
) {
  const updatedPaths: Record<string, any> = {};

  Object.keys(document["paths"]).forEach((path) => {
    updatedPaths[mergePath(basePath, path)] = document["paths"][path];
  });

  return {
    ...document,
    paths: updatedPaths,
  };
}
