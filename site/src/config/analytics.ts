// Self-hosted Umami analytics configuration.
//
// Fill BOTH values once your Umami instance is live (see site/README.md ->
// Analytics for the Docker setup). Leave either empty to DISABLE analytics
// entirely (no script is emitted, the build stays clean). Neither value is a
// secret: both ship in the page HTML and are safe to commit.
//
// You can also override them at build time with the PUBLIC_UMAMI_* env vars
// (handy for CI) without editing this file.

/** Full URL to your Umami tracker script. */
export const UMAMI_SCRIPT_URL: string =
  import.meta.env.PUBLIC_UMAMI_SCRIPT_URL ?? 'https://umami.marlburrow.io/script.js';

/** Website UUID from Umami -> Settings -> Websites -> Edit. */
export const UMAMI_WEBSITE_ID: string =
  import.meta.env.PUBLIC_UMAMI_WEBSITE_ID ?? 'd19b66ed-f349-40dd-af72-a096067c3efd';
