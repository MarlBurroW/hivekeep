import { Hono } from "hono";
import { pluginManager } from "@/server/services/plugins";
import { pluginRegistry } from "@/server/services/pluginRegistry";
import type { AppVariables } from "@/server/app";
import { createLogger } from "@/server/logger";
import { readFile } from "fs/promises";
import { resolve, join } from "path";
import { db } from "@/server/db";
import { userProfiles } from "@/server/db/schema";
import { eq } from "drizzle-orm";

const log = createLogger("routes:plugins");

export const pluginRoutes = new Hono<{ Variables: AppVariables }>();

// Read-only routes (npm search, version) are open to all authenticated users.
// Mutating routes (install, uninstall, enable, disable, config, reload, update) require admin.

/** Middleware: require admin role */
const requireAdmin = async (c: any, next: any) => {
  const currentUser = c.get("user");
  const profile = db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, currentUser.id))
    .get();

  if (!profile || profile.role !== "admin") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Admin access required" } },
      403,
    );
  }
  return next();
};

// ─── Registry routes ─────────────────────────────────────────────────────────

// GET /api/plugins/registry/npm-search — discover plugins via npm
//
// Queries the public npm registry for packages tagged with the
// `hivekeep-plugin` keyword. The user's free-form `q` is combined with
// that keyword filter so authors can search by package name /
// description / their own tags from the Browse tab.
//
// Cached server-side for 5 minutes per query (no per-user data
// involved). Open to any authenticated user; install still requires
// admin (POST /api/plugins/install).
pluginRoutes.get("/registry/npm-search", async (c) => {
  try {
    const q = c.req.query("q") ?? "";
    // `?refresh=true` bypasses the 5min server-side cache. The
    // Marketplace's "Refresh" button passes it so a plugin just
    // published to npm shows up immediately instead of waiting for the
    // cache to expire.
    const force = c.req.query("refresh") === "true";
    const plugins = await pluginRegistry.searchNpm(q, { force });

    // Tag installed plugins so the Browse UI can render the "Already
    // installed" state without a second round-trip. Match by npm
    // package name when present, otherwise fall back to manifest name.
    const installed = pluginManager.listPlugins();
    const installedNpmPackages = new Set<string>();
    const installedNames = new Set<string>();
    for (const p of installed) {
      installedNames.add(p.name);
      if (
        p.installMeta &&
        "package" in p.installMeta &&
        typeof p.installMeta.package === "string"
      ) {
        installedNpmPackages.add(p.installMeta.package);
      }
    }

    return c.json({
      plugins: plugins.map((p) => ({
        ...p,
        installed:
          installedNpmPackages.has(p.name) || installedNames.has(p.name),
      })),
    });
  } catch (err) {
    log.error({ err }, "Failed to search npm for plugins");
    return c.json(
      {
        error: {
          code: "NPM_SEARCH_FAILED",
          message: "Failed to search npm for plugins",
        },
      },
      500,
    );
  }
});

// GET /api/plugins/version — get Hivekeep version for compatibility checks
pluginRoutes.get("/version", async (c) => {
  try {
    const pkgPath = resolve(process.cwd(), "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    return c.json({ version: pkg.version });
  } catch {
    return c.json({ version: "0.0.0" });
  }
});

// ─── Plugin management routes ────────────────────────────────────────────────

// GET /api/plugins — list all plugins
pluginRoutes.get("/", async (c) => {
  const plugins = pluginManager.listPlugins();
  return c.json(plugins);
});

// GET /api/plugins/:name — get a single plugin's details
// GET /api/plugins/updates — check for available plugin updates
// Defined BEFORE `/:name` so Hono's first-match routing doesn't capture
// "updates" as a plugin name. Other literal sub-paths (`/reload`,
// `/install`) are POST so they don't collide with the GET `/:name` rule.
pluginRoutes.get("/updates", async (c) => {
  try {
    const updates = await pluginManager.checkUpdates();
    return c.json({ updates });
  } catch (err) {
    log.error({ err }, "Failed to check plugin updates");
    return c.json(
      {
        error: {
          code: "UPDATE_CHECK_FAILED",
          message: "Failed to check for updates",
        },
      },
      500,
    );
  }
});

pluginRoutes.get("/:name", async (c) => {
  const { name } = c.req.param();
  const plugins = pluginManager.listPlugins();
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) {
    return c.json(
      {
        error: {
          code: "PLUGIN_NOT_FOUND",
          message: `Plugin "${name}" not found`,
        },
      },
      404,
    );
  }
  return c.json(plugin);
});

// GET /api/plugins/:name/readme — get a plugin's README
pluginRoutes.get("/:name/readme", async (c) => {
  const { name } = c.req.param();
  try {
    const pluginDir = resolve(process.cwd(), "plugins", name);
    const readme = await readFile(join(pluginDir, "README.md"), "utf-8");
    return c.json({ readme });
  } catch {
    return c.json({ readme: null });
  }
});

// GET /api/plugins/:name/logo — serve the plugin's logo file declared in
// `manifest.iconUrl`. Path is constrained to the plugin's directory so a
// crafted manifest can't escape via `../`.
pluginRoutes.get("/:name/logo", async (c) => {
  const { name } = c.req.param();
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return c.json(
      { error: { code: "INVALID_NAME", message: "Invalid plugin name" } },
      400,
    );
  }
  try {
    const plugin = pluginManager.getPlugin(name);
    if (!plugin)
      return c.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: "Plugin not found" } },
        404,
      );
    const iconRel = plugin.manifest.iconUrl;
    if (!iconRel)
      return c.json(
        { error: { code: "NO_LOGO", message: "Plugin has no logo" } },
        404,
      );

    const pluginDir = resolve(process.cwd(), "plugins", name);
    const logoPath = resolve(pluginDir, iconRel);
    // Containment check — abort if iconUrl escapes the plugin directory.
    if (!logoPath.startsWith(pluginDir + "/") && logoPath !== pluginDir) {
      return c.json(
        {
          error: {
            code: "INVALID_LOGO_PATH",
            message: "Logo path escapes plugin directory",
          },
        },
        400,
      );
    }

    const buf = await readFile(logoPath);
    const ext = logoPath.slice(logoPath.lastIndexOf(".") + 1).toLowerCase();
    const mime =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "application/octet-stream";
    return new Response(buf as any, {
      headers: {
        "Content-Type": mime,
        // Cache aggressively — logo content is tied to plugin version,
        // a re-install replaces the file on disk and bumps the URL via
        // `/:name/logo` (no version query needed for the local case).
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return c.json(
      { error: { code: "LOGO_NOT_FOUND", message: "Logo file not found" } },
      404,
    );
  }
});

// POST /api/plugins/:name/enable
pluginRoutes.post("/:name/enable", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    await pluginManager.enablePlugin(name);
    return c.json({ success: true });
  } catch (err) {
    log.error({ plugin: name, err }, "Failed to enable plugin");
    return c.json(
      {
        error: {
          code: "PLUGIN_ENABLE_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to enable plugin",
        },
      },
      400,
    );
  }
});

// POST /api/plugins/:name/disable
pluginRoutes.post("/:name/disable", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    await pluginManager.disablePlugin(name);
    return c.json({ success: true });
  } catch (err) {
    log.error({ plugin: name, err }, "Failed to disable plugin");
    return c.json(
      {
        error: {
          code: "PLUGIN_DISABLE_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to disable plugin",
        },
      },
      400,
    );
  }
});

// GET /api/plugins/:name/config
pluginRoutes.get("/:name/config", async (c) => {
  const { name } = c.req.param();
  try {
    const config = await pluginManager.getConfigForAPI(name);
    return c.json(config);
  } catch (err) {
    return c.json(
      { error: { code: "PLUGIN_NOT_FOUND", message: "Plugin not found" } },
      404,
    );
  }
});

// PUT /api/plugins/:name/config
pluginRoutes.put("/:name/config", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    const body = await c.req.json();
    await pluginManager.setConfig(name, body);
    return c.json({ success: true });
  } catch (err) {
    log.error({ plugin: name, err }, "Failed to update plugin config");
    return c.json(
      {
        error: {
          code: "PLUGIN_CONFIG_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to update config",
        },
      },
      400,
    );
  }
});

// POST /api/plugins/:name/health/reset — reset a plugin's health stats (admin only)
pluginRoutes.post("/:name/health/reset", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    pluginManager.resetPluginHealth(name);
    return c.json({ success: true });
  } catch (err) {
    return c.json(
      {
        error: {
          code: "HEALTH_RESET_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to reset health",
        },
      },
      400,
    );
  }
});

// POST /api/plugins/reload
pluginRoutes.post("/reload", requireAdmin, async (c) => {
  try {
    await pluginManager.reload();
    return c.json({ success: true, plugins: pluginManager.listPlugins() });
  } catch (err) {
    log.error({ err }, "Failed to reload plugins");
    return c.json(
      {
        error: {
          code: "PLUGIN_RELOAD_FAILED",
          message: "Failed to reload plugins",
        },
      },
      500,
    );
  }
});

// POST /api/plugins/install — install from git or npm
pluginRoutes.post("/install", requireAdmin, async (c) => {
  try {
    const body = await c.req.json<{
      source: "git" | "npm";
      url?: string;
      package?: string;
    }>();

    if (body.source === "git") {
      if (!body.url)
        return c.json(
          { error: { code: "MISSING_URL", message: "Git URL is required" } },
          400,
        );
      const result = await pluginManager.installFromGit(body.url);
      return c.json({ success: true, name: result.name });
    } else if (body.source === "npm") {
      if (!body.package)
        return c.json(
          {
            error: {
              code: "MISSING_PACKAGE",
              message: "Package name is required",
            },
          },
          400,
        );
      const result = await pluginManager.installFromNpm(body.package);
      return c.json({ success: true, name: result.name });
    } else {
      return c.json(
        {
          error: {
            code: "INVALID_SOURCE",
            message: 'Source must be "git" or "npm"',
          },
        },
        400,
      );
    }
  } catch (err) {
    log.error({ err }, "Failed to install plugin");
    return c.json(
      {
        error: {
          code: "PLUGIN_INSTALL_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to install plugin",
        },
      },
      400,
    );
  }
});

// DELETE /api/plugins/:name — uninstall a plugin
pluginRoutes.delete("/:name", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    await pluginManager.uninstallPlugin(name);
    return c.json({ success: true });
  } catch (err) {
    log.error({ plugin: name, err }, "Failed to uninstall plugin");
    return c.json(
      {
        error: {
          code: "PLUGIN_UNINSTALL_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to uninstall plugin",
        },
      },
      400,
    );
  }
});

// POST /api/plugins/:name/update — update a plugin
pluginRoutes.post("/:name/update", requireAdmin, async (c) => {
  const { name } = c.req.param();
  try {
    await pluginManager.updatePlugin(name);
    return c.json({ success: true });
  } catch (err) {
    log.error({ plugin: name, err }, "Failed to update plugin");
    return c.json(
      {
        error: {
          code: "PLUGIN_UPDATE_FAILED",
          message:
            err instanceof Error ? err.message : "Failed to update plugin",
        },
      },
      400,
    );
  }
});
