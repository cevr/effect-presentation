import http from 'http';

// =============================================================================
// SECTION 1: Types
// =============================================================================

// --- POS Specific Types ---

// Response Body
type MenuResponse = {
  sections: Section[];
  items: Item[];
  modGroups: ModGroup[];
  mods: Mod[];
  discounts: Discount[];
  orderTypes: OrderType[];
}

type Section = {
  id: string;
  name: string;
  itemIds: string[];
  magicCopyKey?: string;
  imageUrl: string;
}

type Item = {
  id: string;
	name: string;
	price: number;
	modGroupIds: string[];
	magicCopyKey?: string;
	imageUrl: string;
}

type ModGroup = {
	id: string;
	name: string;
	modIds: string[];
	maxMods?: number;
	minMods?: number;
}

type Mod = {
	id: string;
	name: string;
	modGroupIds: string[];
	price: number;
}

type Discount = {
	id: string;
	name: string;
	amount?: number;
	rate?: number;
	couponCode?: string;
}

type OrderType = {
	id: string;
	name: string;
}

// --- Domain Specific Types ---

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
// SECTION 2: Core Logic Functions (Inlined - No Services/Classes)
// =============================================================================

// --- Mock Data Generation (Simulates fetching) ---
const generateMockMenuResponse = async (): Promise<MenuResponse> => {
    console.log("generateMockMenuResponse: Simulating API call...");
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate network delay

    if (Math.random() < 0.1) { // Simulate potential random failure
      console.error("generateMockMenuResponse: Simulated network error!");
      throw new Error("Failed to fetch menu from mock source");
    }

    // Hardcoded mock data (previously in MockHttpService/MockPosClient)
    const menu: MenuResponse = {
      sections: [
        { id: 'sec1', name: 'Appetizers', itemIds: ['item1', 'item2'], imageUrl: 'http://e.com/apps.jpg' }, // Simplified URLs for brevity
        { id: 'sec2', name: 'Main Courses', itemIds: ['item3'], imageUrl: 'http://e.com/mains.jpg' },
      ],
      items: [
        { id: 'item1', name: 'Spring Rolls', price: 500, modGroupIds: ['mg1'], imageUrl: 'http://e.com/rolls.jpg' },
        { id: 'item2', name: 'Wings', price: 800, modGroupIds: [], imageUrl: 'http://e.com/wings.jpg' },
        { id: 'item3', name: 'Pizza', price: 1500, modGroupIds: ['mg2', 'mg3'], imageUrl: 'http://e.com/pizza.jpg' },
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
    };
    console.log("generateMockMenuResponse: Successfully generated mock menu.");
    return menu;
};

// --- Type Guards (Helper functions for the parser) ---
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === 'string'; }
function isNumber(value: unknown): value is number { return typeof value === 'number'; }
function isOptionalString(value: unknown): value is string | undefined { return typeof value === 'string' || typeof value === 'undefined'; }
function isOptionalNumber(value: unknown): value is number | undefined { return typeof value === 'number' || typeof value === 'undefined'; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }

function isSection(obj: unknown): obj is Section {
  return isObject(obj) && isString(obj.id) && isString(obj.name) && isStringArray(obj.itemIds) && isOptionalString(obj.magicCopyKey) && isString(obj.imageUrl);
}
function isItem(obj: unknown): obj is Item {
    return isObject(obj) && isString(obj.id) && isString(obj.name) && isNumber(obj.price) && isStringArray(obj.modGroupIds) && isOptionalString(obj.magicCopyKey) && isString(obj.imageUrl);
}
function isModGroup(obj: unknown): obj is ModGroup {
    return isObject(obj) && isString(obj.id) && isString(obj.name) && isStringArray(obj.modIds) && isOptionalNumber(obj.maxMods) && isOptionalNumber(obj.minMods);
}
function isMod(obj: unknown): obj is Mod {
    return isObject(obj) && isString(obj.id) && isString(obj.name) && isStringArray(obj.modGroupIds) && isNumber(obj.price);
}
function isDiscount(obj: unknown): obj is Discount {
    return isObject(obj) && isString(obj.id) && isString(obj.name) && (isOptionalNumber(obj.amount) || isOptionalNumber(obj.rate)) && isOptionalString(obj.couponCode);
}
function isOrderType(obj: unknown): obj is OrderType {
    return isObject(obj) && isString(obj.id) && isString(obj.name);
}

// --- Parser Function ---
const parseAndValidateMenuResponse = (data: unknown): MenuResponse => {
    console.log("parseAndValidateMenuResponse: Validating raw POS data...");
    // Same validation logic as before, using type guards
    if (!isObject(data)) throw new Error("Invalid menu response: Expected an object.");
    if (!Array.isArray(data.sections) || !data.sections.every(isSection)) throw new Error("Invalid 'sections'.");
    if (!Array.isArray(data.items) || !data.items.every(isItem)) throw new Error("Invalid 'items'.");
    if (!Array.isArray(data.modGroups) || !data.modGroups.every(isModGroup)) throw new Error("Invalid 'modGroups'.");
    if (!Array.isArray(data.mods) || !data.mods.every(isMod)) throw new Error("Invalid 'mods'.");
    if (!Array.isArray(data.discounts) || !data.discounts.every(isDiscount)) throw new Error("Invalid 'discounts'.");
    if (!Array.isArray(data.orderTypes) || !data.orderTypes.every(isOrderType)) throw new Error("Invalid 'orderTypes'.");
    console.log("parseAndValidateMenuResponse: Raw POS data validation successful.");
    return data as MenuResponse;
};

// --- Transformer Function ---
const transformPosMenuToDomain = (posMenu: MenuResponse): DomainMenu => {
    console.log("transformPosMenuToDomain: Transforming POS data to domain format...");
    // Same transformation logic as before
    const categories: DomainCategory[] = posMenu.sections.map(s => ({ categoryId: s.id, displayName: s.name, productIds: s.itemIds, imageUrl: s.imageUrl }));
    const products: DomainProduct[] = posMenu.items.map(i => ({ productId: i.id, displayName: i.name, basePrice: i.price, modifierGroupIds: i.modGroupIds, imageUrl: i.imageUrl }));
    const modifierGroups: DomainModifierGroup[] = posMenu.modGroups.map(mg => ({ groupId: mg.id, displayName: mg.name, modifierIds: mg.modIds, maxSelections: mg.maxMods, minSelections: mg.minMods }));
    const modifiers: DomainModifier[] = posMenu.mods.map(m => ({ modifierId: m.id, displayName: m.name, priceDelta: m.price }));
    const domainMenu: DomainMenu = { categories, products, modifierGroups, modifiers };
    console.log("transformPosMenuToDomain: Transformation complete.");
    return domainMenu;
};

// =============================================================================
// SECTION 3: Server Setup and Execution (Inlined Logic)
// =============================================================================

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  if (req.url === '/menu' && req.method === 'GET') {
    try {
      console.log("Server: Received GET /menu request.");

      // 1. Fetch/Generate Data (Inlined)
      const rawMenuData = await generateMockMenuResponse();

      // 2. Parse/Validate Data (Inlined)
      const validatedPosMenu = parseAndValidateMenuResponse(rawMenuData);

      // 3. Transform Data (Inlined)
      const domainMenu = transformPosMenuToDomain(validatedPosMenu);

      console.log("Server: Successfully processed menu request.");
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(domainMenu, null, 2));
      console.log("Server: Successfully responded to GET /menu.");

    } catch (error) {
      console.error("Server: Error handling GET /menu:", error);
      // Basic error handling
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'Internal Server Error',
        error: error instanceof Error ? error.message : 'An unknown error occurred'
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
  console.error('Server error:', error);
});

// =============================================================================
// SECTION 4: Problems with this *Simplified* Vanilla Implementation
// =============================================================================
/*
 * This version reverts to an even simpler structure without explicit services/classes.
 * While seemingly straightforward for this small example, it highlights other issues:
 *
 * 1.  Lack of Modularity & Reusability:
 *     - All logic (fetching, parsing, transforming) is either global or directly within the request handler.
 *     - Difficult to reuse parsing or transformation logic elsewhere.
 *     - Hard to swap implementations (e.g., use a real fetch instead of mock generation).
 *
 * 2.  Testability:
 *     - Extremely difficult to unit test the parsing or transformation logic in isolation.
 *     - Testing requires running the entire server or manually extracting functions.
 *     - Mocking the data generation step (`generateMockMenuResponse`) is awkward.
 *     - Verifying error paths involves complex server setup and request simulation.
 *
 * 3.  Tight Coupling:
 *     - The server handler is tightly coupled to the specific implementation details of data fetching, parsing, and transformation.
 *     - Changes in any part require modifying the main request handling logic.
 *
 * 4.  Error Handling (Still Basic):
 *     - Still relies on basic try...catch and generic Errors.
 *     - Doesn't differentiate error types.
 *
 * 5.  Scalability & Maintainability:
 *     - As the application grows, putting all logic directly in the handler becomes unmanageable.
 *     - Difficult for multiple developers to work on different parts without conflicts.
 *
 * This demonstrates why even basic applications benefit from separating concerns, even if
 * vanilla dependency injection (as shown in the previous refactoring step)
 * introduces its own boilerplate compared to solutions like Effect's Context.
 */