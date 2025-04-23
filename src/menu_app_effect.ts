import { NodeSdk } from "@effect/opentelemetry";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SentrySpanProcessor } from "@sentry/opentelemetry";
import {
  Deferred,
  Logger,
  Queue,
  Random,
  Stream,
  Schema,
  Effect,
  Layer,
  Data,
  Schedule,
  Duration,
  ParseResult,
  ManagedRuntime,
  Scope,
} from "effect";
import http from "http"; // Add Node.js http module

// =============================================================================
// SECTION 1: Errors (Using Data.TaggedError for typed errors)
// =============================================================================

class NetworkError extends Schema.TaggedError<NetworkError>("NetworkError")(
  "NetworkError",
  {
    message: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
    cause: Schema.Unknown.pipe(Schema.optional),
  }
) {
  static is = Schema.is(this);
}

class NetworkFailure extends Schema.TaggedError<NetworkFailure>(
  "NetworkFailure"
)("NetworkFailure", {
  message: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  cause: Schema.Unknown.pipe(Schema.optional),
}) {
  static is = Schema.is(this);
}

class TimeoutError extends Data.TaggedError("TimeoutError")<{
  url: string;
  timeoutMs: number;
}> {}

class TransformationError extends Data.TaggedError("TransformationError")<{
  message: string;
  cause?: unknown;
}> {}

class PosApiError extends Data.TaggedError("PosApiError")<{
  message: string;
  cause?: unknown;
}> {}

class StoreClosedError extends Data.TaggedError("StoreClosedError")<{
  storeId: string;
}> {}

// Combine potential errors for different layers
type HttpServiceError = NetworkError | TimeoutError | NetworkFailure;
type PosApiServiceError = PosApiError | HttpServiceError;
type MenuServiceError =
  | PosApiServiceError
  | ParseResult.ParseError
  | TransformationError
  | StoreClosedError;

// =============================================================================
// SECTION 2: Schemas (@effect/schema)
// =============================================================================

// --- POS Specific Schemas ---
const SectionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  itemIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  magicCopyKey: Schema.optional(Schema.String),
  imageUrl: Schema.String.pipe(Schema.pattern(/^https?:\/\/.+/)), // Basic URL check
});
export type Section = Schema.Schema.Type<typeof SectionSchema>;

const ItemSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  price: Schema.Number.pipe(Schema.int(), Schema.positive()),
  modGroupIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  magicCopyKey: Schema.optional(Schema.String),
  imageUrl: Schema.String.pipe(Schema.pattern(/^https?:\/\/.+/)),
});
export type Item = Schema.Schema.Type<typeof ItemSchema>;

const ModGroupSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  modIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  maxMods: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  minMods: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative())
  ),
});
export type ModGroup = Schema.Schema.Type<typeof ModGroupSchema>;

const ModSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  modGroupIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  price: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
export type Mod = Schema.Schema.Type<typeof ModSchema>;

const DiscountSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  amount: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  rate: Schema.optional(
    Schema.Number.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1))
  ),
  couponCode: Schema.optional(Schema.String),
}).pipe(
  Schema.filter(
    (data): data is typeof data =>
      data.amount !== undefined || data.rate !== undefined,
    {
      message: () => "Discount must have either an amount or a rate",
    }
  )
);
export type Discount = Schema.Schema.Type<typeof DiscountSchema>;

const OrderTypeSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
export type OrderType = Schema.Schema.Type<typeof OrderTypeSchema>;

const MenuResponseSchema = Schema.Struct({
  sections: Schema.Array(SectionSchema),
  items: Schema.Array(ItemSchema),
  modGroups: Schema.Array(ModGroupSchema),
  mods: Schema.Array(ModSchema),
  discounts: Schema.Array(DiscountSchema),
  orderTypes: Schema.Array(OrderTypeSchema),
});
export type MenuResponse = Schema.Schema.Type<typeof MenuResponseSchema>;

// --- Store Configuration Schema ---
const StoreConfigSchema = Schema.Struct({
  storeId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  isOpen: Schema.Boolean,
  currency: Schema.Literal("USD", "CAD", "EUR"),
});
export type StoreConfig = Schema.Schema.Type<typeof StoreConfigSchema>;

// --- Domain Specific Schemas (used for transformation output type) ---
const DomainCategorySchema = Schema.Struct({
  categoryId: Schema.String,
  displayName: Schema.String,
  productIds: Schema.Array(Schema.String),
  imageUrl: Schema.optional(Schema.String),
});
export type DomainCategory = Schema.Schema.Type<typeof DomainCategorySchema>;

const DomainProductSchema = Schema.Struct({
  productId: Schema.String,
  displayName: Schema.String,
  basePrice: Schema.Number,
  modifierGroupIds: Schema.Array(Schema.String),
  imageUrl: Schema.optional(Schema.String),
});
export type DomainProduct = Schema.Schema.Type<typeof DomainProductSchema>;

const DomainModifierGroupSchema = Schema.Struct({
  groupId: Schema.String,
  displayName: Schema.String,
  modifierIds: Schema.Array(Schema.String),
  maxSelections: Schema.optional(Schema.Number),
  minSelections: Schema.optional(Schema.Number),
});
export type DomainModifierGroup = Schema.Schema.Type<
  typeof DomainModifierGroupSchema
>;

const DomainModifierSchema = Schema.Struct({
  modifierId: Schema.String,
  displayName: Schema.String,
  priceDelta: Schema.Number,
});
export type DomainModifier = Schema.Schema.Type<typeof DomainModifierSchema>;

const DomainMenuSchema = Schema.Struct({
  categories: Schema.Array(DomainCategorySchema),
  products: Schema.Array(DomainProductSchema),
  modifierGroups: Schema.Array(DomainModifierGroupSchema),
  modifiers: Schema.Array(DomainModifierSchema),
});
export type DomainMenu = Schema.Schema.Type<typeof DomainMenuSchema>;

// =============================================================================
// SECTION 3: Services (Context)
// =============================================================================

// Helper to copy mock data into the layer definition
const getMockMenuData = () => ({
  sections: [
    {
      id: "sec1",
      name: "Appetizers",
      itemIds: ["item1", "item2"],
      imageUrl: "http://e.com/apps.jpg",
    },
    {
      id: "sec2",
      name: "Main Courses",
      itemIds: ["item3"],
      imageUrl: "http://e.com/mains.jpg",
    },
  ],
  items: [
    {
      id: "item1",
      name: "Spring Rolls",
      price: 500,
      modGroupIds: ["mg1"],
      imageUrl: "http://e.com/rolls.jpg",
    },
    {
      id: "item2",
      name: "Wings",
      price: 800,
      modGroupIds: [],
      imageUrl: "http://e.com/wings.jpg",
    },
    {
      id: "item3",
      name: "Pizza",
      price: 1500,
      modGroupIds: ["mg2", "mg3"],
      imageUrl: "http://e.com/pizza.jpg",
    },
  ],
  modGroups: [
    {
      id: "mg1",
      name: "Sauce Choice",
      modIds: ["mod1", "mod2"],
      minMods: 1,
      maxMods: 1,
    },
    { id: "mg2", name: "Toppings", modIds: ["mod3", "mod4"], maxMods: 2 },
    { id: "mg3", name: "Crust", modIds: ["mod5"], minMods: 1, maxMods: 1 },
  ],
  mods: [
    { id: "mod1", name: "Sweet Chili", modGroupIds: ["mg1"], price: 0 },
    { id: "mod2", name: "Plum Sauce", modGroupIds: ["mg1"], price: 0 },
    { id: "mod3", name: "Pepperoni", modGroupIds: ["mg2"], price: 150 },
    { id: "mod4", name: "Mushrooms", modGroupIds: ["mg2"], price: 100 },
    { id: "mod5", name: "Thin Crust", modGroupIds: ["mg3"], price: 0 },
  ],
  discounts: [
    { id: "disc1", name: "10% Off", rate: 0.1 },
    { id: "disc2", name: "$5 Off", amount: 500, couponCode: "SAVE5" },
  ],
  orderTypes: [
    { id: "ot1", name: "Dine In" },
    { id: "ot2", name: "Take Out" },
  ],
});

const getMockConfigData = () => ({
  storeId: "mock-restaurant",
  name: "The Mock Eatery",
  isOpen: Math.random() > 0.1,
  currency: "USD",
});

const mockApiData = {
  "/api/v1/menus/mock-restaurant": getMockMenuData,
  "/api/v1/config/mock-restaurant": getMockConfigData,
} as const;

class HttpService extends Effect.Service<HttpService>()("HttpService", {
  succeed: {
    get: Effect.fn("HttpService.get")(function* (
      url: keyof typeof mockApiData,
      options: { timeout?: Duration.DurationInput } = {}
    ) {
      const { timeout = Duration.seconds(1) } = options;

      // Simulate fetch with potential errors, retry, and timeout using Effect operators
      return yield* Effect.gen(function* () {
        yield* Effect.log(`MockHttpService: GET ${url}`);
        const randomNumber = yield* Random.nextIntBetween(0, 100);
        const shouldFail = randomNumber <= 10;
        const shouldTimeout = randomNumber <= 40;
        if (shouldFail) {
          return yield* new NetworkFailure({
            message: "Simulated network failure",
            url,
          });
        }
        if (shouldTimeout) {
          return yield* new NetworkError({
            message: "Simulated network flake",
            url,
          });
        }
        return mockApiData[url]();
      }).pipe(
        Effect.delay(Duration.millis(50)), // Simulate base latency
        // Retry only on NetworkError
        Effect.retry({
          while: NetworkError.is,
          schedule: Schedule.tapOutput(
            Schedule.intersect(
              Schedule.recurs(3),
              Schedule.exponential(Duration.millis(500))
            ),
            ([n, d]) =>
              Effect.log(
                `[RETRY] Retrying ${n + 1} of 3 in ${Duration.toMillis(d)}ms`
              )
          ),
        }),

        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new TimeoutError({ url, timeoutMs: Duration.toMillis(timeout) }),
        }),
        // Log errors during retry attempts
        Effect.tapError((e) =>
          Effect.logWarning(
            `MockHttpService: Attempt failed for ${url}. Reason: ${e._tag}`
          )
        )
      );
    },
    Effect.withLogSpan("HttpService.get")),
  },
}) {}

// --- POS API Service ---

class PosApiService extends Effect.Service<PosApiService>()("PosApiService", {
  // dependencies: [HttpService.Default],
  effect: Effect.gen(function* () {
    const httpService = yield* HttpService;
    return {
      fetchMenu: Effect.fn("PosApiService.fetchMenu")(function* () {
        yield* Effect.log("PosApiService: Fetching menu...");
        const menu = yield* httpService
          .get("/api/v1/menus/mock-restaurant", {
            timeout: Duration.millis(2000),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PosApiError({ message: "Failed to fetch menu", cause })
            )
          );
        return menu;
      }, Effect.withLogSpan("PosApiService.fetchMenu")),
      fetchStoreConfig: Effect.fn("PosApiService.fetchStoreConfig")(
        function* () {
          yield* Effect.log("PosApiService: Fetching store config...");
          const config = yield* httpService
            .get("/api/v1/config/mock-restaurant", {
              timeout: Duration.millis(2000),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PosApiError({
                    message: "Failed to fetch store config",
                    cause,
                  })
              )
            );
          return config;
        },
        Effect.withLogSpan("PosApiService.fetchStoreConfig")
      ),
    };
  }),
}) {}

// --- Menu Parser Service ---

class MenuParserService extends Effect.Service<MenuParserService>()(
  "MenuParserService",
  {
    succeed: {
      parseMenuResponse: Effect.fn("MenuParserService.parseMenuResponse")(
        function* (data: unknown) {
          yield* Effect.log("MenuParserService: Parsing menu response...");
          return yield* Schema.decodeUnknown(MenuResponseSchema)(data).pipe(
            Effect.tap(() => Effect.logDebug("Parsed menu response"))
          );
        },
        Effect.withLogSpan("MenuParserService.parseMenuResponse")
      ),
      parseStoreConfig: Effect.fn("parseStoreConfig")(function* (
        data: unknown
      ) {
        yield* Effect.log("MenuParserService: Parsing store config...");
        return yield* Schema.decodeUnknown(StoreConfigSchema)(data).pipe(
          Effect.tap(() => Effect.logDebug("Parsed store config"))
        );
      },
      Effect.withLogSpan("MenuParserService.parseStoreConfig")),
    },
  }
) {}

// --- Menu Transformer Service ---

class MenuTransformerService extends Effect.Service<MenuTransformerService>()(
  "MenuTransformerService",
  {
    succeed: {
      transform: Effect.fn("MenuTransformerService.transform")(function* (
        posMenu: MenuResponse,
        config: StoreConfig
      ) {
        yield* Effect.log("MenuTransformerService: Transforming menu...");
        return yield* Effect.try({
          try: () => {
            const priceMultiplier = config.currency === "USD" ? 1 : 1.1;
            const categories = posMenu.sections.map((s) => ({
              categoryId: s.id,
              displayName: s.name,
              productIds: s.itemIds,
              imageUrl: s.imageUrl,
            }));
            const products = posMenu.items.map((i) => ({
              productId: i.id,
              displayName: i.name,
              basePrice: Math.round(i.price * priceMultiplier),
              modifierGroupIds: i.modGroupIds,
              imageUrl: i.imageUrl,
            }));
            const modifierGroups = posMenu.modGroups.map((mg) => ({
              groupId: mg.id,
              displayName: mg.name,
              modifierIds: mg.modIds,
              maxSelections: mg.maxMods,
              minSelections: mg.minMods,
            }));
            const modifiers = posMenu.mods.map((m) => ({
              modifierId: m.id,
              displayName: m.name,
              priceDelta: Math.round(m.price * priceMultiplier),
            }));
            return { categories, products, modifierGroups, modifiers };
          },
          catch: (cause) =>
            new TransformationError({
              message: "Failed to transform POS menu",
              cause,
            }),
        });
      },
      Effect.withLogSpan("MenuTransformerService.transform")),
    },
  }
) {}

// Effect.Effect<FinalValue, Errors, Requirements (context)>
const getMenuLogic = Effect.fn("getMenuLogic")(function* () {
  yield* Effect.logInfo("MenuService: Starting menu retrieval...");

  const posApi = yield* PosApiService;
  const parser = yield* MenuParserService;
  const transformer = yield* MenuTransformerService;

  // Fetch in parallel
  const [rawMenuData, rawConfigData] = yield* Effect.all(
    [posApi.fetchMenu(), posApi.fetchStoreConfig()],
    {
      concurrency: "unbounded",
    }
  );
  yield* Effect.logDebug("MenuService: Fetched data in parallel.");

  // Parse in parallel (though parsing is often synchronous, Effect.all handles it)
  const [validatedPosMenu, storeConfig] = yield* Effect.all(
    [
      parser.parseMenuResponse(rawMenuData),
      parser.parseStoreConfig(rawConfigData),
    ],
    { concurrency: "inherit" }
  );
  yield* Effect.logDebug("MenuService: Parsed data.");

  // Conditional Logic
  yield* Effect.logInfo(
    `MenuService: Checking store status... ${storeConfig.isOpen}`
  );
  if (!storeConfig.isOpen) {
    yield* Effect.fail(new StoreClosedError({ storeId: storeConfig.storeId }));
  }

  // Transform
  const domainMenu = yield* transformer.transform(
    validatedPosMenu,
    storeConfig
  );
  yield* Effect.logInfo(
    "MenuService: Successfully retrieved and processed menu."
  );

  return domainMenu;
}, Effect.withLogSpan("getMenuLogic"));

class MenuQueueService extends Effect.Service<MenuQueueService>()(
  "MenuQueueService",
  {
    effect: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<
        Deferred.Deferred<DomainMenu, MenuServiceError>
      >();

      yield* Effect.log("MenuQueueService: Starting queue service...");

      const worker = Effect.forever(
        Stream.fromQueue(queue).pipe(
          Stream.groupedWithin(3, Duration.millis(50)),
          Stream.mapEffect((items) =>
            Effect.forEach(
              items,
              (deferred) =>
                getMenuLogic().pipe(
                  Effect.flatMap((menu) => Deferred.succeed(deferred, menu)),
                  Effect.catchAll((error) => Deferred.fail(deferred, error)),
                  Effect.catchAllDefect((error) =>
                    Deferred.die(deferred, error)
                  )
                ),
              {
                concurrency: "unbounded",
              }
            )
          ),
          Stream.runDrain
        )
      );

      yield* Effect.forkDaemon(worker);

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.log("MenuQueueService: Shutting down...");
          yield* Effect.log(`storing queue into persistent storage...`);
          yield* Queue.shutdown(queue);
        })
      );

      return {
        enqueue: Effect.fn("enqueue")(function* () {
          const deferred = yield* Deferred.make<DomainMenu, MenuServiceError>();
          yield* Queue.offer(queue, deferred);
          return yield* Deferred.await(deferred);
        }, Effect.withLogSpan("MenuQueueService.enqueue")),
      };
    }),
  }
) {}

// =============================================================================
// SECTION 4 : Core Business Logic (as an Effect)
// =============================================================================

// --- Combined Application Layer ---
// make note of the requirements for the layer to show the dependencies
// if they are not provided in order, typescript will not be happy

const getMenu = Effect.fn("getMenu")(function* () {
  const menuQueue = yield* MenuQueueService;
  yield* Effect.log("getMenu: Enqueuing menu request...");
  const menu = yield* menuQueue.enqueue();
  yield* Effect.log("getMenu: Menu retrieved from queue");
  return menu;
}, Effect.withLogSpan("getMenu"));

const ServiceLayer = Layer.mergeAll(
  Layer.provideMerge(PosApiService.Default, HttpService.Default),
  MenuParserService.Default,
  MenuTransformerService.Default
);

// Set up tracing with the OpenTelemetry SDK
const NodeSdkLive = NodeSdk.layer(() => ({
  resource: { serviceName: "menu-service" },
  // Export span data to the console
  // spanProcessor: new BatchSpanProcessor(new ConsoleSpanExporter()),
  // spanProcessor: new SentrySpanProcessor(),
}));

const AppLayer = Layer.provide(MenuQueueService.Default, ServiceLayer).pipe(
  Layer.provide(Layer.scope),
  Layer.provide(NodeSdkLive)
  // Layer.provide(Logger.pretty)
);

const runtime = ManagedRuntime.make(AppLayer);

// =============================================================================
// SECTION 5: HTTP Server (Node.js http module)
// =============================================================================

const server = http.createServer(async (req, res) => {
  if (req.url === "/menu" && req.method === "GET") {
    console.log("Server: Received GET /menu request.");

    // Execute the Effect workflow
    const result = await runtime.runPromise(
      getMenu().pipe(
        Effect.map((domainMenu) => ({
          type: "Ok" as const,
          value: domainMenu,
        })),
        Effect.catchAll((error) => {
          return Effect.succeed({
            type: "Err" as const,
            error: mapMenuServiceErrorToResponse(error),
          });
        }),
        Effect.catchAllDefect(() => {
          return Effect.succeed({
            type: "Err" as const,
            error: {
              statusCode: 500,
              body: { message: "Internal server error" },
            },
          });
        })
      )
    );
    if (result.type === "Ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.value, null, 2));
    } else {
      res.writeHead(result.error.statusCode, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result.error.body, null, 2));
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running using Node http module on port ${PORT}...`);
  console.log(`Try: curl http://localhost:${PORT}/menu`);
});

server.on("error", (error) => {
  console.error("Node Server error:", error);
});

// Helper function to map Effect errors to HTTP responses
const mapMenuServiceErrorToResponse = (error: MenuServiceError) => {
  let statusCode = 500;
  let body: {
    message: string;
    details?: Record<string, unknown>;
  } = { message: "Internal Server Error" };

  switch (error._tag) {
    case "TimeoutError":
      statusCode = 504;
      body = { message: `Upstream timeout: ${error.url}` };
      break;
    case "NetworkError":
      statusCode = 502;
      body = { message: `Upstream network error: ${error.url}` };
      break;
    case "NetworkFailure":
      statusCode = 502;
      body = { message: `Upstream network failure: ${error.url}` };
      break;
    case "StoreClosedError":
      statusCode = 409;
      body = { message: `Store ${error.storeId} is closed.` };
      break;
    case "PosApiError":
    case "TransformationError":
      statusCode = 500;
      body = {
        message: "Internal server error processing menu data.",
        details: {
          type: error._tag,
          cause: error.cause,
        },
      };
      break;
    case "ParseError":
      statusCode = 400;
      body = {
        message: "Validation Error",
        details: {
          type: error._tag,
          issue: error.issue,
        },
      };
      break;
    default: {
      error satisfies never;
      statusCode = 500;
    }
  }

  return {
    statusCode,
    body,
  };
};
