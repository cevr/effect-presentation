import http from 'http';
import { z } from 'zod'; // Import Zod

// =============================================================================
// SECTION 0: Utility Functions & Constants
// =============================================================================

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 1000;

// =============================================================================
// SECTION 1: Custom Error Types
// =============================================================================

// Base error for easier type checking
class AppError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

class NetworkError extends AppError {
  constructor(message: string, public readonly url: string, cause?: unknown) {
    super(message, cause);
  }
}

class TimeoutError extends NetworkError {
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`, url);
  }
}

class ValidationError extends AppError {
  constructor(message: string, public readonly validationErrors: z.ZodIssue[]) {
    // Provide a more detailed message including specific issues
    const issueDetails = validationErrors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    super(`${message}. Issues: ${issueDetails}`, validationErrors);
  }
}

class TransformationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

class PosClientError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

class OperationCancelledError extends AppError {
  constructor(message: string = "Operation was cancelled") {
    super(message);
  }
}

class StoreClosedError extends AppError {
    constructor(storeId: string) {
        super(`Store ${storeId} is closed, cannot process menu.`);
    }
}


// =============================================================================
// SECTION 2: Types & Schemas (POS, Domain, Config)
// =============================================================================

// --- POS Specific Types & Zod Schemas ---
// Keep types for reference, but Zod schemas are now the source of truth for validation

const SectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  itemIds: z.array(z.string().min(1)),
  magicCopyKey: z.string().optional(),
  imageUrl: z.string().url(),
});
type Section = z.infer<typeof SectionSchema>;

const ItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().int().positive(), // Assuming price in cents
  modGroupIds: z.array(z.string().min(1)),
  magicCopyKey: z.string().optional(),
  imageUrl: z.string().url(),
});
type Item = z.infer<typeof ItemSchema>;

const ModGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  modIds: z.array(z.string().min(1)),
  maxMods: z.number().int().positive().optional(),
  minMods: z.number().int().nonnegative().optional(),
});
type ModGroup = z.infer<typeof ModGroupSchema>;

const ModSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  modGroupIds: z.array(z.string().min(1)), // Still here, maybe useful context?
  price: z.number().int().nonnegative(),
});
type Mod = z.infer<typeof ModSchema>;

const DiscountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  amount: z.number().int().positive().optional(),
  rate: z.number().positive().lte(1).optional(),
  couponCode: z.string().optional(),
}).refine(data => data.amount !== undefined || data.rate !== undefined, {
  message: "Discount must have either an amount or a rate",
});
type Discount = z.infer<typeof DiscountSchema>;

const OrderTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
type OrderType = z.infer<typeof OrderTypeSchema>;

const MenuResponseSchema = z.object({
  sections: z.array(SectionSchema),
  items: z.array(ItemSchema),
  modGroups: z.array(ModGroupSchema),
  mods: z.array(ModSchema),
  discounts: z.array(DiscountSchema),
  orderTypes: z.array(OrderTypeSchema),
});
type MenuResponse = z.infer<typeof MenuResponseSchema>;

// --- Store Configuration Types & Schema ---
const StoreConfigSchema = z.object({
    storeId: z.string().min(1),
    name: z.string().min(1),
    isOpen: z.boolean(),
    currency: z.enum(['USD', 'CAD', 'EUR']).default('USD')
});
type StoreConfig = z.infer<typeof StoreConfigSchema>;

// --- Domain Specific Types (No change) ---
// ... DomainMenu, DomainCategory, DomainProduct, etc. types remain the same ...
type DomainMenu = {
  categories: DomainCategory[];
  products: DomainProduct[];
  modifierGroups: DomainModifierGroup[];
  modifiers: DomainModifier[];
}

type DomainCategory = {
  categoryId: string;
  displayName: string;
  productIds: string[];
  imageUrl?: string;
}

type DomainProduct = {
  productId: string;
  displayName: string;
  basePrice: number;
  modifierGroupIds: string[];
  imageUrl?: string;
}

type DomainModifierGroup = {
  groupId: string;
  displayName: string;
  modifierIds: string[];
  maxSelections?: number;
  minSelections?: number;
}

type DomainModifier = {
  modifierId: string;
  displayName: string;
  priceDelta: number;
}

// =============================================================================
// SECTION 3: HTTP Service & POS Client
// =============================================================================

// --- HTTP Service Interface ---

interface IHttpService {
  get(url: string, options?: { timeout?: number, retries?: number, retryDelay?: number }): Promise<unknown>;
}

// --- Mock HTTP Service Implementation (with Retry & Timeout) ---

class MockHttpService implements IHttpService {
  // Store mock raw data for different endpoints
  private mockApiData: Record<string, unknown> = {
    '/api/v1/menus/mock-restaurant': {
      sections: [
        { id: 'sec1', name: 'Appetizers', itemIds: ['item1', 'item2'], imageUrl: 'http://example.com/apps.jpg' },
        { id: 'sec2', name: 'Main Courses', itemIds: ['item3'], imageUrl: 'http://example.com/mains.jpg' },
      ],
      items: [
        { id: 'item1', name: 'Spring Rolls', price: 500, modGroupIds: ['mg1'], imageUrl: 'http://example.com/rolls.jpg' },
        { id: 'item2', name: 'Wings', price: 800, modGroupIds: [], imageUrl: 'http://example.com/wings.jpg' },
        { id: 'item3', name: 'Pizza', price: 1500, modGroupIds: ['mg2', 'mg3'], imageUrl: 'http://example.com/pizza.jpg' },
      ],
      modGroups: [
        { id: 'mg1', name: 'Sauce Choice', modIds: ['mod1', 'mod2'], minMods: 1, maxMods: 1 },
        { id: 'mg2', name: 'Toppings', modIds: ['mod3', 'mod4'], maxMods: 2 },
        { id: 'mg3', name: 'Crust', modIds: ['mod5'], minMods: 1, maxMods: 1 },
      ],
      mods: [
        { id: 'mod1', name: 'Sweet Chili', modGroupIds: ['mg1'], price: 0 },
        { id: 'mod2', name: 'Plum Sauce', modGroupIds: ['mg1'], price: 0 },
        { id: 'mod3', name: 'Pepperoni', modGroupIds: ['mg2'], price: 150 },
        { id: 'mod4', name: 'Mushrooms', modGroupIds: ['mg2'], price: 100 },
        { id: 'mod5', name: 'Thin Crust', modGroupIds: ['mg3'], price: 0 },
      ],
      discounts: [
        { id: 'disc1', name: '10% Off', rate: 0.10 },
        { id: 'disc2', name: '$5 Off', amount: 500, couponCode: 'SAVE5' },
      ],
      orderTypes: [
        { id: 'ot1', name: 'Dine In' },
        { id: 'ot2', name: 'Take Out' },
      ],
    },
    '/api/v1/config/mock-restaurant': {
      storeId: 'mock-restaurant',
      name: 'The Mock Eatery',
      isOpen: Math.random() > 0.1, // Simulate store being closed sometimes (10% chance)
      currency: 'USD'
    }
  };

  async get(url: string, options: { timeout?: number, retries?: number, retryDelay?: number } = {}): Promise<unknown> {
    const { timeout = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRY_ATTEMPTS, retryDelay = DEFAULT_RETRY_DELAY_MS } = options;
    let attempts = 0;

    while (attempts <= retries) {
        attempts++;
        console.log(`MockHttpService: Attempt ${attempts}/${retries + 1} - GET ${url}`);

        try {
            const result = await Promise.race([
                // The actual simulated work
                (async () => {
                    await delay(50); // Simulate base network latency
                    if (Math.random() < 0.2) { // Simulate intermittent network failure (20% chance)
                        console.warn(`MockHttpService: Simulated network flake for ${url} on attempt ${attempts}`);
                        throw new NetworkError('Simulated network failure', url);
                    }
                    if (!this.mockApiData[url]) {
                        throw new NetworkError(`Resource not found at ${url}`, url, { status: 404 });
                    }
                    console.log(`MockHttpService: Attempt ${attempts} - Successfully fetched raw data from ${url}.`);
                    return JSON.parse(JSON.stringify(this.mockApiData[url])); // Deep copy
                })(),
                // The timeout promise
                (async () => {
                    await delay(timeout);
                    throw new TimeoutError(url, timeout);
                })()
            ]);
            return result; // Success
        } catch (error) {
            console.warn(`MockHttpService: Attempt ${attempts} failed for ${url}. Reason: ${error instanceof Error ? error.message : error}`);
            if (error instanceof TimeoutError) {
                // Don't retry on timeout
                throw error;
            }
            if (error instanceof NetworkError && (error.cause as any)?.status === 404) {
                // Don't retry on 404
                throw error;
            }

            if (attempts > retries) {
                console.error(`MockHttpService: Final attempt failed for ${url}. Giving up.`);
                throw new NetworkError(`Failed to fetch ${url} after ${attempts} attempts`, url, error);
            }

            console.log(`MockHttpService: Retrying GET ${url} in ${retryDelay}ms...`);
            await delay(retryDelay);
        }
    }
    // Should be unreachable due to throw in loop, but satisfies TS
    throw new NetworkError(`Failed to fetch ${url} after ${attempts} attempts`, url);
  }
}

// --- POS Client Interface ---

interface IPosClient {
  fetchMenu(): Promise<unknown>;
  fetchStoreConfig(): Promise<unknown>; // Add method for config
}

// --- Mock POS Client Implementation (Uses IHttpService) ---

class MockPosClient implements IPosClient {
  private readonly MENU_API_URL = '/api/v1/menus/mock-restaurant';
  private readonly CONFIG_API_URL = '/api/v1/config/mock-restaurant';

  constructor(private httpService: IHttpService) {}

  async fetchMenu(): Promise<unknown> {
    console.log(`MockPosClient: Requesting menu data via HttpService from ${this.MENU_API_URL}...`);
    try {
      const rawData = await this.httpService.get(this.MENU_API_URL, {
          // Add specific options if needed, e.g., longer timeout for large menus
          timeout: 1500,
          retries: 2
      });
      console.log("MockPosClient: Received raw menu data from HttpService.");
      return rawData;
    } catch (error) {
      console.error("MockPosClient: Error fetching menu.", error);
      throw new PosClientError(`Failed to fetch menu`, error);
    }
  }

  async fetchStoreConfig(): Promise<unknown> {
    console.log(`MockPosClient: Requesting store config via HttpService from ${this.CONFIG_API_URL}...`);
    try {
      // Config might be faster, use default retry/timeout
      const rawData = await this.httpService.get(this.CONFIG_API_URL);
      console.log("MockPosClient: Received raw store config from HttpService.");
      return rawData;
    } catch (error) {
        console.error("MockPosClient: Error fetching store config.", error);
        throw new PosClientError(`Failed to fetch store config`, error);
    }
  }
}

// =============================================================================
// SECTION 4: Core Logic Services (Parsing & Transformation)
// =============================================================================

// --- Parser Interface & Implementation (using Zod) ---

interface IMenuParser {
  parseMenuResponse(data: unknown): MenuResponse;
  parseStoreConfig(data: unknown): StoreConfig;
}

class ZodMenuParser implements IMenuParser {
  parseMenuResponse(data: unknown): MenuResponse {
    console.log("ZodMenuParser: Validating raw menu data...");
    try {
      // Use Zod to parse and validate
      const validatedData = MenuResponseSchema.parse(data);
      console.log("ZodMenuParser: Menu data validation successful.");
      return validatedData;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("ZodMenuParser: Menu data validation failed.", error.issues);
        // Wrap Zod error in our custom ValidationError
        throw new ValidationError("Invalid menu response structure", error.issues);
      } else {
        console.error("ZodMenuParser: Unexpected parsing error.", error);
        throw new AppError("An unexpected error occurred during menu parsing", error);
      }
    }
  }

  parseStoreConfig(data: unknown): StoreConfig {
    console.log("ZodMenuParser: Validating raw store config data...");
    try {
      const validatedData = StoreConfigSchema.parse(data);
      console.log("ZodMenuParser: Store config validation successful.");
      return validatedData;
    } catch (error) {
        if (error instanceof z.ZodError) {
            console.error("ZodMenuParser: Store config validation failed.", error.issues);
            throw new ValidationError("Invalid store config structure", error.issues);
          } else {
            console.error("ZodMenuParser: Unexpected config parsing error.", error);
            throw new AppError("An unexpected error occurred during config parsing", error);
          }
    }
  }
}

// --- Transformer Interface & Implementation (Error Handling Added) ---

interface IMenuTransformer {
  transform(posMenu: MenuResponse, config: StoreConfig): DomainMenu; // Now needs config
}

class DefaultMenuTransformer implements IMenuTransformer {
  transform(posMenu: MenuResponse, config: StoreConfig): DomainMenu {
    console.log(`Transformer: Transforming POS data to domain format for store ${config.storeId}...`);
    try {
      // Example: Maybe transformation logic depends on currency?
      const priceMultiplier = config.currency === 'USD' ? 1 : 1.1; // Trivial example

      const categories: DomainCategory[] = posMenu.sections.map(s => ({
        categoryId: s.id,
        displayName: s.name,
        productIds: s.itemIds,
        imageUrl: s.imageUrl
      }));
      const products: DomainProduct[] = posMenu.items.map(i => ({
        productId: i.id,
        displayName: i.name,
        basePrice: Math.round(i.price * priceMultiplier), // Apply multiplier
        modifierGroupIds: i.modGroupIds,
        imageUrl: i.imageUrl
      }));
      const modifierGroups: DomainModifierGroup[] = posMenu.modGroups.map(mg => ({
        groupId: mg.id,
        displayName: mg.name,
        modifierIds: mg.modIds,
        maxSelections: mg.maxMods,
        minSelections: mg.minMods
      }));
      const modifiers: DomainModifier[] = posMenu.mods.map(m => ({
        modifierId: m.id,
        displayName: m.name,
        priceDelta: Math.round(m.price * priceMultiplier) // Apply multiplier
      }));
      const domainMenu: DomainMenu = { categories, products, modifierGroups, modifiers };
      console.log("Transformer: Transformation complete.");
      return domainMenu;
    } catch (error) {
      console.error("Transformer: Error during transformation.", error);
      throw new TransformationError("Failed to transform POS menu to domain format", error);
    }
  }
}

// =============================================================================
// SECTION 5: Service Layer (Orchestration)
// =============================================================================

// --- Cancellation Token (Basic Simulation) ---
// In a real app, this might be tied to request objects or a more robust system
class CancellationToken {
    private _isCancelled = false;
    get isCancelled() { return this._isCancelled; }
    cancel() { this._isCancelled = true; }
    throwIfCancelled() {
        if (this._isCancelled) {
            throw new OperationCancelledError();
        }
    }
}

class MenuService {
  constructor(
    private posClient: IPosClient,
    private parser: IMenuParser,
    private transformer: IMenuTransformer
  ) {}

  // Now accepts an optional CancellationToken
  async getMenu(cancellationToken = new CancellationToken()): Promise<DomainMenu> {
    console.log("MenuService: Starting menu retrieval...");

    try {
        cancellationToken.throwIfCancelled(); // Check before starting

        // 1. Fetch menu and config in parallel
        console.log("MenuService: Fetching menu and store config in parallel...");
        const [rawMenuData, rawConfigData] = await Promise.all([
            this.posClient.fetchMenu(),
            this.posClient.fetchStoreConfig()
        ]);

        cancellationToken.throwIfCancelled(); // Check after fetching

        // 2. Parse and Validate both
        console.log("MenuService: Parsing and validating fetched data...");
        const [validatedPosMenu, storeConfig] = await Promise.all([
            (async () => this.parser.parseMenuResponse(rawMenuData))(), // Wrap in async for Promise.all
            (async () => this.parser.parseStoreConfig(rawConfigData))()
        ]);

        cancellationToken.throwIfCancelled(); // Check after parsing

        // 3. Conditional Logic: Check if store is open
        console.log(`MenuService: Checking if store ${storeConfig.storeId} is open... Status: ${storeConfig.isOpen}`);
        if (!storeConfig.isOpen) {
            throw new StoreClosedError(storeConfig.storeId);
        }

        // 4. Transform to Domain Model (if store is open)
        console.log("MenuService: Transforming menu...");
        const domainMenu = this.transformer.transform(validatedPosMenu, storeConfig);

        cancellationToken.throwIfCancelled(); // Final check before returning

        console.log("MenuService: Successfully retrieved and processed menu.");
        return domainMenu;

    } catch (error) {
        // Log specific error types for better debugging
        if (error instanceof OperationCancelledError) {
            console.warn(`MenuService: ${error.message}`);
        } else if (error instanceof StoreClosedError) {
            console.warn(`MenuService: ${error.message}`);
        } else if (error instanceof ValidationError) {
            console.error(`MenuService: Validation Error - ${error.message}`);
        } else if (error instanceof NetworkError) {
            console.error(`MenuService: Network Error fetching from ${error.url} - ${error.message}`);
        } else if (error instanceof PosClientError) {
            console.error(`MenuService: POS Client Error - ${error.message}`);
        } else if (error instanceof TransformationError) {
            console.error(`MenuService: Transformation Error - ${error.message}`);
        } else {
            console.error("MenuService: Unknown error during menu retrieval:", error);
        }

        // Re-throw the original error to be handled by the caller (server)
        throw error;
    }
  }
}

// =============================================================================
// SECTION 6: Server Setup and Execution
// =============================================================================

const PORT = 3000;

// 1. Instantiate services
const httpService = new MockHttpService();
const posClient = new MockPosClient(httpService);
const menuParser = new ZodMenuParser(); // Use Zod parser
const menuTransformer = new DefaultMenuTransformer();
const menuService = new MenuService(posClient, menuParser, menuTransformer);

const server = http.createServer(async (req, res) => {
  if (req.url === '/menu' && req.method === 'GET') {
    // Simulate a cancellation token for the request (basic)
    const cancellationToken = new CancellationToken();
    // Example: Simulate cancellation if request takes too long (e.g., > 2s)
    // const timeoutId = setTimeout(() => cancellationToken.cancel(), 2000);

    try {
      console.log("Server: Received GET /menu request.");
      const domainMenu: DomainMenu = await menuService.getMenu(cancellationToken);
      // clearTimeout(timeoutId); // Clear timeout if successful

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(domainMenu, null, 2));
      console.log("Server: Successfully responded to GET /menu.");

    } catch (error) {
      // clearTimeout(timeoutId); // Clear timeout if error occurred
      console.error("Server: Error handling GET /menu:", error instanceof Error ? error.message : error);

      // Handle specific error types with appropriate status codes
      let statusCode = 500;
      let errorMessage = 'Internal Server Error';
      let errorDetails: any = undefined;

      if (error instanceof ValidationError) {
        statusCode = 400; // Bad Request
        errorMessage = 'Invalid data received from upstream service.';
        errorDetails = error.validationErrors; // Include details
      } else if (error instanceof TimeoutError) {
        statusCode = 504; // Gateway Timeout
        errorMessage = `Upstream service timed out: ${error.url}`;
      } else if (error instanceof NetworkError) {
        statusCode = 502; // Bad Gateway
        errorMessage = `Network error communicating with upstream service: ${error.url}`;
      } else if (error instanceof StoreClosedError) {
        statusCode = 409; // Conflict (or other suitable code)
        errorMessage = error.message;
      } else if (error instanceof OperationCancelledError) {
          statusCode = 499; // Client Closed Request (non-standard, but common)
          errorMessage = error.message;
      } else if (error instanceof PosClientError || error instanceof TransformationError) {
        statusCode = 500;
        errorMessage = 'Internal error processing menu data.';
      } else if (error instanceof AppError) {
          // Catch-all for other AppErrors
          errorMessage = error.message;
      } // Otherwise, keep generic 500

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: errorMessage,
        // Optionally include more details in non-prod environments
        ...(process.env.NODE_ENV !== 'production' && error instanceof Error ? { details: error.message, type: error.name, ...(errorDetails ? {validationIssues: errorDetails} : {}) } : {})
      }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`Try: curl http://localhost:${PORT}/menu`);
});

server.on('error', (error) => {
  console.error('Server error (e.g., address in use):', error);
});
// =============================================================================
// SECTION 7: Problems with this "Improved" Vanilla Implementation
// =============================================================================
/*
 * This version attempts to address some shortcomings of the basic vanilla app,
 * but demonstrates the significant increase in complexity:
 *
 * 1.  Error Handling:
 *     - Custom error classes help, but require careful definition and propagation.
 *     - `try...catch` blocks become nested and more complex, especially with async/parallel flows.
 *     - Mapping errors to HTTP responses is manual and verbose.
 *     - Effect provides structured errors (typed fail channel) and operators for handling.
 *
 * 2.  Data Validation / Parsing:
 *     - Zod is a great improvement over manual type guards.
 *     - Integrating Zod requires wrapping its errors into application-specific errors.
 *     - Effect's @effect/schema integrates seamlessly with the Effect ecosystem.
 *
 * 3.  Asynchronicity & Control Flow:
 *     - Implementing retry/timeout logic manually adds significant boilerplate (loops, Promise.race, delays).
 *     - Parallel execution (`Promise.all`) is okay, but error handling for partial failures is verbose.
 *     - Conditional logic intermingles with async operations, reducing clarity.
 *     - Cancellation is hard to implement correctly and reliably without a dedicated primitive like Effect's Fiber interrupts.
 *     - Effect provides operators (retry, timeout, parallel, race, etc.) that handle these patterns declaratively and robustly.
 *
 * 4.  Dependency Management:
 *     - Still relies on manual instantiation, though interfaces help.
 *     - Effect's Context system provides superior, type-safe dependency management.
 *
 * 5.  Composability & Readability:
 *     - The code is significantly longer and harder to follow due to nested logic and boilerplate.
 *     - Combining operations remains imperative and less reusable.
 *     - Effect workflows are highly composable and often more readable.
 *
 * 6.  Testing:
 *     - Testing the retry/timeout/cancellation logic becomes much more complex.
 *     - Need to mock timers, Promises, and potentially complex class interactions.
 *     - Effect's test utilities make testing complex async and error logic easier.
 *
 * In essence, while possible to build these features manually, the code becomes
 * fragile, complex, and difficult to maintain compared to using a framework
 * like Effect that provides robust, composable primitives for these common concerns.
 */
