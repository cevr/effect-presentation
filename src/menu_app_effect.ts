import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Data from "effect/Data";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import * as ParseResult from "effect/ParseResult";
import http from "http"; // Add Node.js http module
import { Deferred, Queue, Scope, Stream } from "effect";

// =============================================================================
// SECTION 1: Errors (Using Data.TaggedError for typed errors)
// =============================================================================

class NetworkError extends Data.TaggedError("NetworkError")<{
  message: string;
  url: string;
  cause?: unknown;
}> {}

class TimeoutError extends Data.TaggedError("TimeoutError")<{
  url: string;
  timeoutMs: number;
}> {}

// Use ParseResult.ParseError for validation errors from @effect/schema

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
type HttpServiceError = NetworkError | TimeoutError;
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
type Section = Schema.Schema.Type<typeof SectionSchema>;

const ItemSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  price: Schema.Number.pipe(Schema.int(), Schema.positive()),
  modGroupIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  magicCopyKey: Schema.optional(Schema.String),
  imageUrl: Schema.String.pipe(Schema.pattern(/^https?:\/\/.+/)),
});
type Item = Schema.Schema.Type<typeof ItemSchema>;

const ModGroupSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  modIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  maxMods: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  minMods: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative())
  ),
});
type ModGroup = Schema.Schema.Type<typeof ModGroupSchema>;

const ModSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  modGroupIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  price: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
type Mod = Schema.Schema.Type<typeof ModSchema>;

const DiscountSchemaBase = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  amount: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  rate: Schema.optional(
    Schema.Number.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1))
  ),
  couponCode: Schema.optional(Schema.String),
});

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
type Discount = Schema.Schema.Type<typeof DiscountSchema>;

const OrderTypeSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
type OrderType = Schema.Schema.Type<typeof OrderTypeSchema>;

const MenuResponseSchema = Schema.Struct({
  sections: Schema.Array(SectionSchema),
  items: Schema.Array(ItemSchema),
  modGroups: Schema.Array(ModGroupSchema),
  mods: Schema.Array(ModSchema),
  discounts: Schema.Array(DiscountSchema),
  orderTypes: Schema.Array(OrderTypeSchema),
});
type MenuResponse = Schema.Schema.Type<typeof MenuResponseSchema>;

// --- Store Configuration Schema ---
const StoreConfigSchema = Schema.Struct({
  storeId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  isOpen: Schema.Boolean,
  currency: Schema.Literal("USD", "CAD", "EUR").pipe(
    Schema.annotations({ default: "USD" })
  ),
});
type StoreConfig = Schema.Schema.Type<typeof StoreConfigSchema>;

// --- Domain Specific Schemas (used for transformation output type) ---
const DomainCategorySchema = Schema.Struct({
  categoryId: Schema.String,
  displayName: Schema.String,
  productIds: Schema.Array(Schema.String),
  imageUrl: Schema.optional(Schema.String),
});
type DomainCategory = Schema.Schema.Type<typeof DomainCategorySchema>;

const DomainProductSchema = Schema.Struct({
  productId: Schema.String,
  displayName: Schema.String,
  basePrice: Schema.Number,
  modifierGroupIds: Schema.Array(Schema.String),
  imageUrl: Schema.optional(Schema.String),
});
type DomainProduct = Schema.Schema.Type<typeof DomainProductSchema>;

const DomainModifierGroupSchema = Schema.Struct({
  groupId: Schema.String,
  displayName: Schema.String,
  modifierIds: Schema.Array(Schema.String),
  maxSelections: Schema.optional(Schema.Number),
  minSelections: Schema.optional(Schema.Number),
});
type DomainModifierGroup = Schema.Schema.Type<typeof DomainModifierGroupSchema>;

const DomainModifierSchema = Schema.Struct({
  modifierId: Schema.String,
  displayName: Schema.String,
  priceDelta: Schema.Number,
});
type DomainModifier = Schema.Schema.Type<typeof DomainModifierSchema>;

const DomainMenuSchema = Schema.Struct({
  categories: Schema.Array(DomainCategorySchema),
  products: Schema.Array(DomainProductSchema),
  modifierGroups: Schema.Array(DomainModifierGroupSchema),
  modifiers: Schema.Array(DomainModifierSchema),
});
type DomainMenu = Schema.Schema.Type<typeof DomainMenuSchema>;

// =============================================================================
// SECTION 3: Services (Context)
// =============================================================================

// Helper to copy mock data into the layer definition
const mockMenuData = {
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
};
const mockConfigData = {
  storeId: "mock-restaurant",
  name: "The Mock Eatery",
  isOpen: Math.random() > 0.1,
  currency: "USD",
};

const mockApiData: Record<string, unknown> = {
  "/api/v1/menus/mock-restaurant": mockMenuData,
  "/api/v1/config/mock-restaurant": mockConfigData,
};

class HttpService extends Effect.Service<HttpService>()("HttpService", {
  sync: () => {
    return {
      get: (
        url: string,
        options: { timeout?: Duration.DurationInput } = {}
      ) => {
        const { timeout = Duration.seconds(1) } = options;

        // Simulate fetch with potential errors, retry, and timeout using Effect operators
        return Effect.suspend(() => {
          console.log(`MockHttpService: GET ${url}`);
          if (Math.random() < 0.2)
            return Effect.fail(
              new NetworkError({ message: "Simulated network flake", url })
            );
          if (!mockApiData[url])
            return Effect.fail(
              new NetworkError({
                message: "Not found",
                url,
                cause: { status: 404 },
              })
            );
          return Effect.succeed(
            JSON.parse(JSON.stringify(mockApiData[url])) as unknown
          );
        }).pipe(
          Effect.delay(Duration.millis(50)), // Simulate base latency
          // Retry only on NetworkError (excluding 404)
          Effect.retry({
            while: (error) => error._tag === "NetworkError",
            schedule: Schedule.union(
              Schedule.recurs(3),
              Schedule.exponential(Duration.millis(500))
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
    };
  },
}) {}

// --- POS API Service ---

class PosApiService extends Effect.Service<PosApiService>()("PosApiService", {
  // dependencies: [HttpService.Default],
  effect: Effect.gen(function* () {
    const httpService = yield* HttpService;
    return {
      fetchMenu: Effect.fn("fetchMenu")(function* () {
        yield* Effect.log("PosApiService: Fetching menu...");
        const menu = yield* httpService
          .get("/api/v1/menus/mock-restaurant", {
            timeout: Duration.millis(1500),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PosApiError({ message: "Failed to fetch menu", cause })
            )
          );
        return menu;
      }),
      fetchStoreConfig: Effect.fn("fetchStoreConfig")(function* () {
        yield* Effect.log("PosApiService: Fetching store config...");
        const config = yield* httpService
          .get("/api/v1/config/mock-restaurant", {
            timeout: Duration.millis(1500),
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
      }),
    };
  }),
}) {}

// --- Menu Parser Service ---

class MenuParserService extends Effect.Service<MenuParserService>()(
  "MenuParserService",
  {
    succeed: {
      parseMenuResponse: Effect.fn("parseMenuResponse")(function* (
        data: unknown
      ) {
        yield* Effect.log("MenuParserService: Parsing menu response...");
        return yield* Schema.decodeUnknown(MenuResponseSchema)(data).pipe(
          Effect.tap(() => Effect.logDebug("Parsed menu response"))
        );
      }),
      parseStoreConfig: Effect.fn("parseStoreConfig")(function* (
        data: unknown
      ) {
        yield* Effect.log("MenuParserService: Parsing store config...");
        return yield* Schema.decodeUnknown(StoreConfigSchema)(data).pipe(
          Effect.tap(() => Effect.logDebug("Parsed store config"))
        );
      }),
    },
  }
) {}

// --- Menu Transformer Service ---

class MenuTransformerService extends Effect.Service<MenuTransformerService>()(
  "MenuTransformerService",
  {
    succeed: {
      transform: Effect.fn("transform")(function* (
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
      }),
    },
  }
) {}

const getMenuLogic = Effect.gen(function* () {
  yield* Effect.logInfo("MenuService: Starting menu retrieval...");

  const posApi = yield* PosApiService;
  const parser = yield* MenuParserService;
  const transformer = yield* MenuTransformerService;

  // Fetch in parallel
  const [rawMenuData, rawConfigData] = yield* Effect.all(
    [posApi.fetchMenu(), posApi.fetchStoreConfig()],
    {
      concurrency: "inherit",
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
}).pipe(Effect.annotateLogs({ module: "getMenuLogic" }));

class MenuQueueService extends Effect.Service<MenuQueueService>()(
  "MenuQueueService",
  {
    effect: Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const queue = yield* Queue.unbounded<
        Deferred.Deferred<
          Effect.Effect.Success<typeof getMenuLogic>,
          MenuServiceError
        >
      >();

      const worker = Effect.forever(
        Stream.fromQueue(queue).pipe(
          Stream.mapEffect((deferred) =>
            getMenuLogic.pipe(
              Effect.flatMap((menu) => Deferred.succeed(deferred, menu)),
              Effect.catchAll((error) => Deferred.fail(deferred, error)),
              Effect.catchAllDefect((error) => Deferred.die(deferred, error))
            )
          ),
          Stream.runDrain
        )
      );

      yield* Effect.forkIn(worker, scope);

      return {
        enqueue: Effect.fn("enqueue")(function* () {
          const deferred = yield* Deferred.make<
            Effect.Effect.Success<typeof getMenuLogic>,
            MenuServiceError
          >();
          yield* Queue.offer(queue, deferred);
          return yield* Deferred.await(deferred);
        }),
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

const getMenu = Effect.gen(function* () {
  const menuQueue = yield* MenuQueueService;
  return yield* menuQueue.enqueue();
}).pipe(Effect.annotateLogs({ module: "getMenu" }));

const ServiceLayer = Layer.mergeAll(
  Layer.provideMerge(PosApiService.Default, HttpService.Default),
  MenuParserService.Default,
  MenuTransformerService.Default
);

// Define the Effect workflow with its dependencies provided
const workflow = Effect.scoped(
  Effect.provide(getMenu, Layer.provide(MenuQueueService.Default, ServiceLayer))
);

// =============================================================================
// SECTION 5: HTTP Server (Node.js http module)
// =============================================================================

const server = http.createServer((req, res) => {
  if (req.url === "/menu" && req.method === "GET") {
    console.log("Server: Received GET /menu request.");

    // Execute the Effect workflow
    runEffect(workflow).then((domainMenu) => {
      // Handle success
      if (domainMenu.type === "Ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(domainMenu.value, null, 2));
      } else {
        res.writeHead(domainMenu.error.statusCode, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(domainMenu.error.body, null, 2));
      }
    });
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

type EffectResult<Value> =
  | { type: "Ok"; value: Value }
  | {
      type: "Err";
      error: {
        statusCode: number;
        body: {
          message: string;
          details?: Record<string, unknown>;
        };
      };
    };

function runEffect<Value>(
  effect: Effect.Effect<Value, MenuServiceError, never>
): Promise<EffectResult<Value>> {
  return Effect.runPromise(
    effect.pipe(
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
}

// Helper function to map Effect errors to HTTP responses
const mapMenuServiceErrorToResponse = (error: MenuServiceError) => {
  console.error("Server: Error processing request:", error);

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
      body = { message: "Internal server error" };
    }
  }

  return {
    statusCode,
    body,
  };
};

// SECTION 6: Effect Version Benefits
/*
 * Comparison to vanilla_pro.ts:
 * - Core logic is declarative Effect workflow (getMenuLogic).
 * - Dependencies managed via Layer.
 * - Error handling, validation, retry, timeout handled by Effect operators within services/logic.
 * - HTTP server is now standard Node.js, but it simply executes the Effect program.
 * - Demonstrates how Effect logic can be run in different environments (Node.js server here).
 */
