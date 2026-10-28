// Actual components with reviewed sample data, not operator screenshots.
import Image from "next/image";
const screenshots = {
  preview: {
    file: "workspace-preview.png",
    width: 1440,
    height: 1000,
    alt: "Wrenly workspace with conversation, revision controls, local preview and published-app access",
    caption:
      "Workspace with sample project data. The application displayed inside the preview is illustrative.",
  },
  source: {
    file: "workspace-source.png",
    width: 1440,
    height: 1000,
    alt: "Selected revision source tree, code view, download action and retained failure diagnostics",
    caption:
      "Saved source and diagnostics remain available for a failed revision. Example project data.",
  },
  skills: {
    file: "skills-library.png",
    width: 1440,
    height: 1100,
    alt: "Skills library with a saved instruction document and explicit version controls",
    caption: "The Skills library, shown with a sample instruction document.",
  },
  settings: {
    file: "project-settings.png",
    width: 1440,
    height: 1100,
    alt: "Project settings with General and Collaboration tabs, project details and Skill controls",
    caption:
      "Project settings with a sample shared project. IDs and account data are synthetic.",
  },
} as const;
export function ProductScreenshot({
  name,
}: {
  name: keyof typeof screenshots;
}): React.JSX.Element {
  const image = screenshots[name];
  if (!image) throw new Error("Unknown documentation screenshot.");
  return (
    <figure className="docs-product-screenshot not-prose">
      <a
        href={`/screenshots/${image.file}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open full-size screenshot: ${image.alt}`}
      >
        <Image
          unoptimized
          src={`/screenshots/${image.file}`}
          width={image.width}
          height={image.height}
          alt={image.alt}
          loading="lazy"
        />
      </a>
      <figcaption>
        {image.caption} <span>Open image ↗</span>
      </figcaption>
    </figure>
  );
}
