import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Home,
  FolderKanban,
  ListTodo,
  CalendarClock,
  Folder,
  Blocks,
  Boxes,
  SquareTerminal,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/client/components/ui/dropdown-menu";
import { cn } from "@/client/lib/utils";
import { useAuth } from "@/client/hooks/useAuth";
import { useTasksContext } from "@/client/contexts/TasksContext";
import { useCronsContext } from "@/client/contexts/CronsContext";
import { GezyLogo } from "@/client/components/common/GezyLogo";
import { ThemeToggle } from "@/client/components/common/ThemeToggle";
import { PaletteToggle } from "@/client/components/common/PaletteToggle";
import { UserMenu } from "@/client/components/common/UserMenu";
import { NotificationBell } from "@/client/components/notifications/NotificationBell";
import { SSEStatusIndicator } from "@/client/components/common/SSEStatusIndicator";
import { QueueIndicator } from "@/client/components/layout/QueueIndicator";
import { SetupChecklistButton } from "@/client/components/layout/SetupChecklistButton";
import { UpdateAvailableButton } from "@/client/components/layout/UpdateAvailableButton";

interface AppTopBarProps {
  /** Open a settings section (or the default tab). */
  onOpenSettings: (section?: string, filters?: { agentId?: string }) => void;
  /** Open the account dialog. */
  onOpenAccount: () => void;
}

/**
 * Persistent top bar shown across all authenticated pages (Agents, Projets, etc.).
 *
 * Hosts global actions: brand, SSE indicator, palette/theme toggles, notifications,
 * user menu. Lives at the App.tsx layout level so it doesn't disappear when the
 * user navigates between modes via the ActivityBar.
 *
 * The Agents-specific SidebarTrigger (toggle for the shadcn Sidebar) stays inside
 * ChatPage's local header — it depends on SidebarProvider context which is scoped
 * to that page.
 */
export function AppTopBar({ onOpenSettings, onOpenAccount }: AppTopBarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { activeTasks } = useTasksContext();
  const { pendingApprovalCount: pendingCronCount } = useCronsContext();
  const activeTaskCount = activeTasks.length;
  const hasAwaitingTask = activeTasks.some(
    (task) =>
      task.status === "awaiting_human_input" ||
      task.status === "awaiting_agent_response",
  );
  // Aggregate signal for the collapsed (<sm) dropdown trigger: any section that
  // would show a badge contributes. Pending cron approvals always read as
  // warning (they need user action), same as a task awaiting input.
  const attentionCount = activeTaskCount + pendingCronCount;
  const hasWarning = hasAwaitingTask || pendingCronCount > 0;

  // Mobile mode switch — the left ActivityBar rail is hidden below md, so the
  // section nav moves into this always-present top bar as a compact icon-only
  // segmented control mirroring the ActivityBar destinations (incl. the
  // admin-only Models entry).
  const isAdmin = user?.role === "admin";
  const path = location.pathname;
  const sectionPrefixes = [
    "/projects",
    "/tasks",
    "/crons",
    "/files",
    "/mini-apps",
    "/models",
    "/terminal",
  ];
  const isSection = (prefix: string) => path.startsWith(prefix);
  const modeItems: Array<{
    key: string;
    to: string;
    icon: typeof Home;
    active: boolean;
    label: string;
    badgeKey?: "tasks" | "crons";
  }> = [
    {
      key: "agents",
      to: "/",
      icon: Home,
      active: !sectionPrefixes.some(isSection),
      label: t("activityBar.agents"),
    },
    {
      key: "projects",
      to: "/projects",
      icon: FolderKanban,
      active: isSection("/projects"),
      label: t("activityBar.projects"),
    },
    {
      key: "tasks",
      to: "/tasks",
      icon: ListTodo,
      active: isSection("/tasks"),
      label: t("activityBar.tasks"),
      badgeKey: "tasks",
    },
    {
      key: "crons",
      to: "/crons",
      icon: CalendarClock,
      active: isSection("/crons"),
      label: t("activityBar.crons"),
      badgeKey: "crons",
    },
    {
      key: "files",
      to: "/files",
      icon: Folder,
      active: isSection("/files"),
      label: t("activityBar.files"),
    },
    {
      key: "apps",
      to: "/mini-apps",
      icon: Blocks,
      active: isSection("/mini-apps"),
      label: t("activityBar.apps"),
    },
    ...(isAdmin
      ? [
          {
            key: "models",
            to: "/models",
            icon: Boxes,
            active: isSection("/models"),
            label: t("activityBar.models"),
          },
          {
            key: "terminal",
            to: "/terminal",
            icon: SquareTerminal,
            active: isSection("/terminal"),
            label: t("activityBar.terminal"),
          },
        ]
      : []),
  ];

  // Resolve a mode item's badge from the live counts (mirrors ActivityBar).
  const badgeFor = (
    badgeKey?: "tasks" | "crons",
  ): { count: number; warning: boolean } | null => {
    if (badgeKey === "tasks")
      return activeTaskCount > 0
        ? { count: activeTaskCount, warning: hasAwaitingTask }
        : null;
    if (badgeKey === "crons")
      return pendingCronCount > 0
        ? { count: pendingCronCount, warning: true }
        : null;
    return null;
  };

  return (
    <header className="surface-header sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b px-2.5 sm:gap-3 sm:px-4">
      <button
        type="button"
        className="flex shrink-0 items-center"
        onClick={() => navigate("/")}
        aria-label="Gezy"
      >
        {/* Single themable lockup: the mark follows the active palette gradient.
            The wordmark collides with the right cluster at very narrow widths
            (<=375px), so it's hidden on mobile; the mark alone keeps the brand. */}
        <GezyLogo
          size={28}
          withWordmark
          wordmarkClassName="hidden sm:inline"
          title={null}
        />
      </button>

      {/* Phone (<sm): the section icons can't all fit next to the right cluster,
          so they collapse into a single dropdown — current section icon + chevron. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative flex h-8 shrink-0 items-center gap-1 rounded-lg bg-muted/60 px-2 text-primary sm:hidden"
            aria-label={t("appTopBar.sections", "Sections")}
          >
            {(() => {
              const active =
                modeItems.find((item) => item.active) ?? modeItems[0]!;
              const ActiveIcon = active.icon;
              return <ActiveIcon className="size-4" strokeWidth={1.75} />;
            })()}
            <ChevronDown className="size-3 text-muted-foreground" />
            {attentionCount > 0 && (
              <span
                className={cn(
                  "absolute -right-1 -top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] font-semibold leading-none",
                  hasWarning
                    ? "animate-pulse bg-warning text-warning-foreground"
                    : "bg-primary text-primary-foreground",
                )}
              >
                {attentionCount}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {modeItems.map((item) => {
            const Icon = item.icon;
            const badge = badgeFor(item.badgeKey);
            return (
              <DropdownMenuItem
                key={item.key}
                onClick={() => navigate(item.to)}
                className={item.active ? "text-primary" : undefined}
              >
                <Icon className="size-4" />
                {item.label}
                {badge && (
                  <span
                    className={cn(
                      "ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
                      badge.warning
                        ? "bg-warning text-warning-foreground"
                        : "bg-primary text-primary-foreground",
                    )}
                  >
                    {badge.count}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* sm → md: the icon-only segmented control (the left ActivityBar rail
          takes over at md+). */}
      <nav
        className="hidden shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 sm:flex md:hidden"
        aria-label={t("appTopBar.sections", "Sections")}
      >
        {modeItems.map((item) => {
          const Icon = item.icon;
          const badge = badgeFor(item.badgeKey);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.to)}
              title={item.label}
              aria-label={item.label}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                // size-7 keeps six items within the width five size-8 items
                // used to take — the control only renders below md anyway.
                "relative flex size-7 items-center justify-center rounded-md transition-colors",
                item.active
                  ? "bg-background text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={1.75} />
              {badge && (
                <span
                  className={cn(
                    "absolute -right-1 -top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] font-semibold leading-none",
                    badge.warning
                      ? "animate-pulse bg-warning text-warning-foreground"
                      : "bg-primary text-primary-foreground",
                  )}
                >
                  {badge.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 sm:gap-1">
        {user && <UpdateAvailableButton />}
        {user && <QueueIndicator />}
        <SSEStatusIndicator />
        {user && <SetupChecklistButton onOpenSettings={onOpenSettings} />}
        <PaletteToggle />
        <ThemeToggle />
        {user && <NotificationBell onOpenSettings={onOpenSettings} />}
        {user && (
          <UserMenu
            user={{
              firstName: user.firstName,
              lastName: user.lastName,
              pseudonym: user.pseudonym,
              email: user.email,
              avatarUrl: user.avatarUrl,
            }}
            onLogout={logout}
            onOpenSettings={() => onOpenSettings()}
            onOpenAccount={onOpenAccount}
          />
        )}
      </div>
    </header>
  );
}
