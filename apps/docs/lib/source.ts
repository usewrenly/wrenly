// Never load instance/private filesystem content.
import { docs } from "../.source/server";
import { loader } from "fumadocs-core/source";
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
