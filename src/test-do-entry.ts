// Minimal worker entry for the Workers-pool Durable Object tests. Re-exports just
// the IssueStore DO so the test pool can bind it without loading the full worker
// graph (mcp/oauth/pipeline + Vectorize/AI bindings that have no local emulation).
export { IssueStore } from "./store.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test-only entry");
  },
};
