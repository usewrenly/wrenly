import { redirect } from "next/navigation";
/** The public documentation app has no marketing signup or external service setup. */
export default function Home(): never {
  redirect("/docs");
}
