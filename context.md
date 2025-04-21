# Project Context: Effect Presentation Backend Comparison

## Goal

This repository demonstrates the benefits of using the Effect library for backend development in TypeScript, particularly compared to traditional "vanilla" approaches.

The goal is to showcase how Effect addresses common complexities like error handling, asynchronous operations, dependency management, and validation in a more robust, composable, and maintainable way.

We achieve this by progressively building a Point-of-Sale (POS) menu fetching application:

1.  **Vanilla JS/TS:** A basic version mimicking typical interview-style or minimally viable code.
2.  **Vanilla JS/TS "Pro":** An attempt to add production-level features (retries, timeouts, validation, parallelism, cancellation) to the vanilla version, highlighting the resulting complexity.
3.  **Effect:** Refactoring the application using Effect primitives to show the improvements in code structure, reliability, and developer experience.

## File Descriptions

### `src/menu_app_vanilla.ts`

*   **Purpose:** Represents the initial, most basic implementation.
*   **Characteristics:**
    *   Uses standard Node.js `http` module for the server.
    *   Fetches/generates mock data directly.
    *   Uses manual type guards for basic validation.
    *   Performs a simple transformation.
    *   Minimal error handling (basic `try...catch` with generic `Error`).
    *   No dependency injection or modular services; logic is largely inlined within the request handler.
*   **Demonstrates:** The baseline functionality and the inherent lack of testability, modularity, and robustness in a naive implementation.

### `src/menu_app_vanilla_pro.ts`

*   **Purpose:** Simulates adding necessary real-world features to the basic vanilla version **without** using Effect.
*   **Characteristics:**
    *   Introduces `zod` for schema-based validation.
    *   Defines custom error classes for better error categorization.
    *   Implements manual retry and timeout logic in the HTTP fetching layer.
    *   Uses `AbortController` for handling request cancellation.
    *   Fetches multiple pieces of data (menu, config) in parallel using `Promise.all`.
    *   Includes conditional logic based on fetched data (e.g., store open status).
    *   Separates concerns into interfaces and classes (`IHttpService`, `IPosApi`, `IMenuParser`, `IMenuTransformer`, `MenuService`) with manual dependency injection.
    *   Maps custom errors to appropriate HTTP status codes in the server response.
*   **Demonstrates:** The significant increase in code complexity, boilerplate, and manual orchestration required to build more robust features using only standard TypeScript/JavaScript patterns and libraries like Zod. This serves as a direct contrast to the declarative and composable approach Effect offers for these same concerns.