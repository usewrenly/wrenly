// Compile public guides only.
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
export const docs = defineDocs({ dir: "content/docs" });
export default defineConfig();
