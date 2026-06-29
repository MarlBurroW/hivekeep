import { useState } from 'react'
import { toast } from 'sonner'
import { usePalette } from '@/client/components/theme-provider'
import { PaletteSwitcher } from '@/client/components/common/PaletteSwitcher'
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Info,
  AlertTriangle,
  Bell,
  Search,
  Settings,
  User,
  Bot,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
  Copy,
  Pencil,
  Sparkles,
  Zap,
  Wand2,
  Star,
  Heart,
  ChevronDown,
  ChevronRight,
  PanelRight,
  ExternalLink,
  BarChart3,
  Palette,
  Type,
  MousePointerClick,
  TextCursorInput,
  LayoutGrid,
  Tag,
  ShieldAlert,
  ToggleLeft,
  Layers,
  PanelLeftClose,
  MessageCircle,
  Activity,
  ScrollText,
  ChevronsUpDown,
  BellRing,
  Shapes,
  Ruler,
  Terminal,
  SlidersHorizontal,
  ToggleRight,
  Navigation,
  Home,
  FileText,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ShieldCheck,
  Rocket,
  MousePointer,
  Play,
  Crown,
  Wrench,
  X,
  Settings2,
} from 'lucide-react'

import { cn } from '@/client/lib/utils'
import { TOOL_DOMAIN_META } from '@/shared/constants'
import type { BuiltinToolDomain } from '@/shared/types'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { ToolDomainBadge } from '@/client/components/common/ToolDomainBadge'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/client/components/ui/card'
import { Badge } from '@/client/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/client/components/ui/alert'
import { Checkbox } from '@/client/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/client/components/ui/radio-group'
import { Switch } from '@/client/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/client/components/ui/dialog'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField, FormRow } from '@/client/components/common/FormField'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/client/components/ui/alert-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/client/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/client/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/client/components/ui/tooltip'
import { Avatar, AvatarFallback } from '@/client/components/ui/avatar'
import { Label } from '@/client/components/ui/label'
import { Skeleton } from '@/client/components/ui/skeleton'
import { Progress } from '@/client/components/ui/progress'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/client/components/ui/sheet'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { Toaster } from '@/client/components/ui/sonner'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/client/components/ui/breadcrumb'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/client/components/ui/command'
import { Slider } from '@/client/components/ui/slider'
import { Toggle } from '@/client/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/client/components/ui/toggle-group'

/* ─── Nav sections ────────────────────────────────────────── */

const NAV_SECTIONS = [
  { id: 'surfaces', label: 'Surfaces', icon: Layers },
  { id: 'colors', label: 'Colors', icon: Palette },
  { id: 'typography', label: 'Typography', icon: Type },
  { id: 'buttons', label: 'Buttons', icon: MousePointerClick },
  { id: 'inputs', label: 'Inputs', icon: TextCursorInput },
  { id: 'slider', label: 'Slider', icon: SlidersHorizontal },
  { id: 'toggle', label: 'Toggle', icon: ToggleRight },
  { id: 'cards', label: 'Cards', icon: LayoutGrid },
  { id: 'badges', label: 'Badges', icon: Tag },
  { id: 'alerts', label: 'Alerts', icon: ShieldAlert },
  { id: 'form-controls', label: 'Form Controls', icon: ToggleLeft },
  { id: 'dialog', label: 'Dialog', icon: Layers },
  { id: 'sheet', label: 'Sheet', icon: PanelRight },
  { id: 'popover', label: 'Popover', icon: MessageCircle },
  { id: 'command', label: 'Command', icon: Terminal },
  { id: 'breadcrumb', label: 'Breadcrumb', icon: Navigation },
  { id: 'tabs-dropdown', label: 'Tabs & Dropdown', icon: ChevronsUpDown },
  { id: 'progress', label: 'Progress', icon: Activity },
  { id: 'scroll-area', label: 'Scroll Area', icon: ScrollText },
  { id: 'collapsible', label: 'Collapsible', icon: ChevronsUpDown },
  { id: 'toast', label: 'Toast', icon: BellRing },
  { id: 'avatars', label: 'Avatars', icon: User },
  { id: 'animations', label: 'Animations', icon: Play },
  { id: 'gezy-patterns', label: 'Gezy Patterns', icon: Shapes },
  { id: 'tool-calls', label: 'Tool Calls', icon: Wrench },
  { id: 'loading-states', label: 'Loading States', icon: Loader2 },
  { id: 'spacing', label: 'Spacing & Layout', icon: Ruler },
] as const

/* ─── Helpers ─────────────────────────────────────────────── */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-6 scroll-mt-20 animate-fade-in-up">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        <div className="flex-1 separator-gradient" />
      </div>
      {children}
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

function ColorSwatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`size-16 rounded-xl shadow-sm ring-1 ring-black/5 ${className}`} />
      <span className="text-xs font-medium">{name}</span>
    </div>
  )
}

/* ─── Main ────────────────────────────────────────────────── */

export function DesignSystemPage() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formDialogOpen, setFormDialogOpen] = useState(false)
  const [dialogSuccessOpen, setDialogSuccessOpen] = useState(false)
  const [progressVal, setProgressVal] = useState(42)
  const [collapsibleOpen, setCollapsibleOpen] = useState(false)
  const { palette, palettes } = usePalette()
  const currentPalette = palettes.find(p => p.id === palette)

  return (
    <TooltipProvider>
      <div className="min-h-screen surface-base text-foreground">
        <Toaster />

        {/* ─── HEADER ───────────────────────────────────────── */}
        <header className="sticky top-0 z-50 surface-header border-b">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-3">
              <div className="gradient-primary flex size-9 items-center justify-center rounded-lg shadow-md glow-primary">
                <Wand2 className="size-4 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold gradient-primary-text">Gezy Design System</h1>
                <p className="text-[10px] text-muted-foreground">{currentPalette?.name ?? 'Aurora'} &mdash; 32 components &middot; {NAV_SECTIONS.length} sections</p>
              </div>
            </div>
            <PaletteSwitcher />
          </div>
        </header>

        {/* ─── HERO ─────────────────────────────────────────── */}
        <div className="relative overflow-hidden border-b">
          <div className="theme-orb theme-orb-1 size-72 -top-20 -left-20" />
          <div className="theme-orb theme-orb-2 size-60 top-10 right-10" style={{ animationDelay: '-3s' }} />
          <div className="theme-orb theme-orb-3 size-48 bottom-0 left-1/3" style={{ animationDelay: '-5s' }} />

          <div className="relative mx-auto max-w-7xl px-6 py-16 text-center">
            <div className="inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-sm font-medium text-primary mb-4">
              <Sparkles className="size-4" /> Design System v2
            </div>
            <h2 className="text-5xl font-bold tracking-tight">
              <span className="gradient-primary-text">{currentPalette?.name ?? 'Aurora'}</span>
            </h2>
            <p className="mx-auto mt-3 max-w-md text-muted-foreground">
              {currentPalette?.description ?? 'Purple \u2192 Pink \u2192 Peach'}. Every surface alive with color.
              Glassmorphism, glow, and motion.
            </p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <Button size="lg" className="gradient-primary-hover border-0 text-white shadow-lg glow-primary">
                <Zap className="size-4" /> Get Started
              </Button>
              <Button size="lg" variant="outline" className="glass">
                <Star className="size-4" /> Explore
              </Button>
            </div>
          </div>
        </div>

        {/* ─── LAYOUT: sidebar + content ─────────────────────── */}
        <div className="mx-auto max-w-7xl flex">

          {/* Sidebar nav */}
          <nav className="hidden lg:block sticky top-[57px] h-[calc(100vh-57px)] w-56 shrink-0 overflow-y-auto border-r py-4 px-3 surface-sidebar">
            <ul className="space-y-0.5">
              {NAV_SECTIONS.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <main className="flex-1 min-w-0 space-y-16 px-6 lg:px-10 py-12">

            {/* ─── SURFACES ──────────────────────────────────── */}
            <Section id="surfaces" title="Surfaces & Backgrounds">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Every surface carries the theme palette &mdash; color undertones shift
                across backgrounds, cards, sidebars, and panels. Nothing is flat.
              </p>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {/* surface-base — page background simulation */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="surface-base p-5 h-36 flex flex-col justify-between">
                    <div className="flex items-center gap-2">
                      <div className="size-2 rounded-full bg-primary/40" />
                      <div className="h-2 w-16 rounded bg-primary/10" />
                      <div className="h-2 w-10 rounded bg-primary/10 ml-auto" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">surface-base</p>
                      <p className="text-sm mt-0.5">Multi-point gradient wash</p>
                    </div>
                  </div>
                </div>

                {/* surface-card — card with content preview */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="surface-card p-5 h-36 flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="h-2.5 w-24 rounded bg-primary/15" />
                      <div className="h-2 w-full rounded bg-muted" />
                      <div className="h-2 w-3/4 rounded bg-muted" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">surface-card</p>
                      <p className="text-sm mt-0.5">Iridescent diagonal tint</p>
                    </div>
                  </div>
                </div>

                {/* surface-sidebar — sidebar layout */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="surface-sidebar p-5 h-36 flex flex-col justify-between">
                    <div className="space-y-1.5">
                      {['Dashboard', 'Agents', 'Settings'].map((l) => (
                        <div key={l} className="flex items-center gap-2">
                          <div className="size-3 rounded bg-primary/15" />
                          <div className="h-2 w-14 rounded bg-muted-foreground/15" />
                        </div>
                      ))}
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">surface-sidebar</p>
                      <p className="text-sm mt-0.5">Vertical gradient sweep</p>
                    </div>
                  </div>
                </div>

                {/* surface-chat — chat layout */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="surface-chat p-5 h-36 flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="flex justify-end"><div className="h-5 w-28 rounded-full bg-primary/15" /></div>
                      <div className="flex"><div className="h-5 w-36 rounded-full bg-muted" /></div>
                      <div className="flex justify-end"><div className="h-5 w-20 rounded-full bg-primary/15" /></div>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">surface-chat</p>
                      <p className="text-sm mt-0.5">Top accent glow</p>
                    </div>
                  </div>
                </div>

                {/* surface-header — header bar */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="surface-header p-5 h-36 flex flex-col justify-between">
                    <div className="flex items-center gap-3">
                      <div className="size-6 rounded-md gradient-primary" />
                      <div className="h-2.5 w-20 rounded bg-primary/15" />
                      <div className="ml-auto flex gap-1.5">
                        <div className="size-5 rounded-full bg-muted" />
                        <div className="size-5 rounded-full bg-muted" />
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">surface-header</p>
                      <p className="text-sm mt-0.5">Gradient strip + blur</p>
                    </div>
                  </div>
                </div>

                {/* gradient-mesh — hero section */}
                <div className="overflow-hidden rounded-xl border">
                  <div className="gradient-mesh p-5 h-36 flex flex-col justify-between">
                    <div className="text-center pt-2">
                      <div className="h-4 w-32 mx-auto rounded bg-primary/15" />
                      <div className="h-2 w-20 mx-auto rounded bg-muted mt-2" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">gradient-mesh</p>
                      <p className="text-sm mt-0.5">Full gradient mesh</p>
                    </div>
                  </div>
                </div>
              </div>

              <SubSection title="Glass & Glow">
                <div className="relative rounded-2xl gradient-mesh py-14 px-8">
                  <div className="theme-orb theme-orb-1 size-56 -top-16 -left-16" />
                  <div className="theme-orb theme-orb-2 size-48 -bottom-12 -right-12" style={{ animationDelay: '-3s' }} />
                  <div className="theme-orb theme-orb-3 size-36 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ animationDelay: '-5s' }} />

                  <div className="relative grid gap-5 sm:grid-cols-3">
                    <div className="glass rounded-xl p-5 text-center">
                      <Bot className="mx-auto size-7 text-primary" />
                      <h4 className="mt-2 font-semibold">Glass</h4>
                      <p className="mt-1 text-xs text-muted-foreground">Frosted translucent</p>
                    </div>
                    <div className="glass-strong rounded-xl p-5 text-center">
                      <Sparkles className="mx-auto size-7 text-primary" />
                      <h4 className="mt-2 font-semibold">Glass Strong</h4>
                      <p className="mt-1 text-xs text-muted-foreground">More opaque</p>
                    </div>
                    <div className="gradient-border gradient-border-animated rounded-xl bg-card p-5 text-center">
                      <Zap className="mx-auto size-7 text-primary" />
                      <h4 className="mt-2 font-semibold">Animated Border</h4>
                      <p className="mt-1 text-xs text-muted-foreground">Shifting gradient outline</p>
                    </div>
                  </div>

                  <div className="relative mt-8 flex items-center justify-center gap-4 flex-wrap">
                    <span className="glow-primary gradient-primary rounded-full px-5 py-2 text-sm font-medium text-white">
                      Glow Primary
                    </span>
                    <span className="glow-accent rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground">
                      Glow Accent
                    </span>
                  </div>
                </div>
              </SubSection>
            </Section>

            {/* ─── COLORS ────────────────────────────────────── */}
            <Section id="colors" title="Color Palette">
              <div className="grid gap-8 lg:grid-cols-2">
                <div className="space-y-6">
                  <SubSection title="Core">
                    <div className="flex flex-wrap gap-3">
                      <ColorSwatch name="Primary" className="bg-primary" />
                      <ColorSwatch name="Secondary" className="bg-secondary" />
                      <ColorSwatch name="Accent" className="bg-accent" />
                      <ColorSwatch name="Muted" className="bg-muted" />
                    </div>
                  </SubSection>
                  <SubSection title="Semantic">
                    <div className="flex flex-wrap gap-3">
                      <ColorSwatch name="Success" className="bg-success" />
                      <ColorSwatch name="Warning" className="bg-warning" />
                      <ColorSwatch name="Error" className="bg-destructive" />
                      <ColorSwatch name="Info" className="bg-info" />
                    </div>
                  </SubSection>
                  <SubSection title="Chart Colors">
                    <div className="flex flex-wrap gap-3">
                      <ColorSwatch name="Chart 1" className="bg-chart-1" />
                      <ColorSwatch name="Chart 2" className="bg-chart-2" />
                      <ColorSwatch name="Chart 3" className="bg-chart-3" />
                      <ColorSwatch name="Chart 4" className="bg-chart-4" />
                      <ColorSwatch name="Chart 5" className="bg-chart-5" />
                    </div>
                  </SubSection>
                </div>
                <div className="space-y-6">
                  <SubSection title="Gradients">
                    <div className="flex flex-wrap gap-3">
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-16 w-32 rounded-xl shadow-md gradient-primary" />
                        <span className="text-xs font-medium">Primary</span>
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-16 w-32 rounded-xl shadow-md gradient-primary-hover" />
                        <span className="text-xs font-medium">Animated</span>
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-16 w-32 rounded-xl gradient-subtle border" />
                        <span className="text-xs font-medium">Subtle</span>
                      </div>
                    </div>
                  </SubSection>
                  <SubSection title="Text & Links">
                    <div className="space-y-1.5 surface-card rounded-xl p-4 border">
                      <p className="font-semibold">Foreground</p>
                      <p className="text-muted-foreground">Muted foreground</p>
                      <p className="text-primary font-semibold">Primary</p>
                      <p className="text-link hover:text-link-hover cursor-pointer underline underline-offset-4">
                        Link color <ExternalLink className="inline size-3" />
                      </p>
                      <p className="gradient-primary-text font-bold text-lg">Gradient text</p>
                    </div>
                  </SubSection>
                </div>
              </div>
            </Section>

            {/* ─── TYPOGRAPHY ──────────────────────────────────── */}
            <Section id="typography" title="Typography">
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="surface-card rounded-xl p-6 border space-y-2">
                  <h1 className="text-4xl font-bold tracking-tight">Heading 1</h1>
                  <h2 className="text-3xl font-bold tracking-tight">Heading 2</h2>
                  <h3 className="text-2xl font-semibold">Heading 3</h3>
                  <h4 className="text-xl font-semibold">Heading 4</h4>
                  <h5 className="text-lg font-medium">Heading 5</h5>
                  <h6 className="text-base font-medium text-muted-foreground">Heading 6</h6>
                </div>
                <div className="surface-card rounded-xl p-6 border space-y-4">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Body Sizes</p>
                    <p className="text-lg">Large &mdash; For featured text</p>
                    <p className="text-base">Default &mdash; Main body</p>
                    <p className="text-sm text-muted-foreground">Small &mdash; Secondary</p>
                    <p className="text-xs text-muted-foreground">Caption &mdash; Fine print</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Weights</p>
                    <p className="font-normal">Regular 400</p>
                    <p className="font-medium">Medium 500</p>
                    <p className="font-semibold">Semibold 600</p>
                    <p className="font-bold">Bold 700</p>
                  </div>
                </div>
              </div>
            </Section>

            {/* ─── BUTTONS ─────────────────────────────────────── */}
            <Section id="buttons" title="Buttons">
              <SubSection title="Variants">
                <div className="flex flex-wrap items-center gap-3">
                  <Button>Primary</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button variant="link">Link</Button>
                </div>
              </SubSection>
              <SubSection title="Gradient Buttons">
                <div className="flex flex-wrap items-center gap-3">
                  <Button className="gradient-primary border-0 text-white shadow-lg glow-primary btn-shine">
                    <Sparkles className="size-4" /> Gradient CTA
                  </Button>
                  <Button className="gradient-primary-hover border-0 text-white shadow-md btn-magnetic">
                    <Wand2 className="size-4" /> Animated
                  </Button>
                  <Button variant="outline" className="gradient-border gradient-border-animated btn-press">
                    Gradient Border
                  </Button>
                  <Button variant="outline" className="glass btn-press">
                    <Star className="size-4" /> Glass Button
                  </Button>
                  <Button variant="outline" className="gradient-border-spin btn-ripple">
                    <Crown className="size-4" /> Spinning Border
                  </Button>
                </div>
              </SubSection>
              <SubSection title="Sizes & States">
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="xs">XS</Button>
                  <Button size="sm">Small</Button>
                  <Button>Default</Button>
                  <Button size="lg">Large</Button>
                  <Button disabled>Disabled</Button>
                  <Button disabled><Loader2 className="size-4 animate-spin" /> Loading</Button>
                </div>
              </SubSection>
              <SubSection title="With Icons">
                <div className="flex flex-wrap items-center gap-3">
                  <Button><Plus className="size-4" /> Create Agent</Button>
                  <Button variant="outline"><Settings className="size-4" /> Settings</Button>
                  <Button variant="destructive"><Trash2 className="size-4" /> Delete</Button>
                  <Button variant="ghost" size="icon"><Heart className="size-4" /></Button>
                  <Button variant="ghost" size="icon"><Bell className="size-4" /></Button>
                </div>
              </SubSection>
            </Section>

            {/* ─── INPUTS ──────────────────────────────────────── */}
            <Section id="inputs" title="Inputs">
              <div className="grid gap-8 lg:grid-cols-2">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="i1">Default</Label>
                    <Input id="i1" placeholder="Type something..." />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="i2">With value</Label>
                    <Input id="i2" defaultValue="Hello Gezy" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="i3">Error</Label>
                    <Input id="i3" aria-invalid="true" defaultValue="bad-value" />
                    <p className="text-sm text-destructive">This field is invalid</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="i4">With icon</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input id="i4" className="pl-9" placeholder="Search memories..." />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="i5">Disabled</Label>
                    <Input id="i5" disabled placeholder="Not editable" />
                  </div>
                </div>
                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="ta1">Textarea</Label>
                    <Textarea id="ta1" placeholder="Describe your Agent's personality..." rows={4} />
                  </div>
                  <div className="space-y-2">
                    <Label>Select</Label>
                    <Select>
                      <SelectTrigger><SelectValue placeholder="Choose a model" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">Claude Sonnet 4</SelectItem>
                        <SelectItem value="gpt4">GPT-4o</SelectItem>
                        <SelectItem value="gemini">Gemini 2.5 Pro</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </Section>

            {/* ─── SLIDER ─────────────────────────────────────── */}
            <Section id="slider" title="Slider">
              <div className="max-w-lg space-y-6">
                <SubSection title="Default">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Temperature</Label>
                      <Slider defaultValue={[70]} max={100} step={1} />
                    </div>
                    <div className="space-y-2">
                      <Label>Range</Label>
                      <Slider defaultValue={[25, 75]} max={100} step={1} />
                    </div>
                    <div className="space-y-2">
                      <Label>Disabled</Label>
                      <Slider defaultValue={[50]} max={100} step={1} disabled />
                    </div>
                  </div>
                </SubSection>
                <SubSection title="Gradient Variant">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Creativity</Label>
                      <Slider defaultValue={[65]} max={100} step={1} variant="gradient" />
                    </div>
                    <div className="space-y-2">
                      <Label>Token Range</Label>
                      <Slider defaultValue={[20, 80]} max={100} step={1} variant="gradient" />
                    </div>
                  </div>
                </SubSection>
                <SubSection title="Steps">
                  <div className="space-y-2">
                    <Label>Step: 25</Label>
                    <Slider defaultValue={[50]} max={100} step={25} />
                  </div>
                </SubSection>
              </div>
            </Section>

            {/* ─── TOGGLE ────────────────────────────────────── */}
            <Section id="toggle" title="Toggle & Toggle Group">
              <div className="space-y-6">
                <SubSection title="Single Toggle">
                  <div className="flex flex-wrap items-center gap-3">
                    <Toggle aria-label="Toggle bold"><Bold className="size-4" /></Toggle>
                    <Toggle aria-label="Toggle italic"><Italic className="size-4" /></Toggle>
                    <Toggle aria-label="Toggle underline"><Underline className="size-4" /></Toggle>
                    <Toggle aria-label="Toggle bold" variant="outline"><Bold className="size-4" /></Toggle>
                    <Toggle aria-label="Disabled" disabled><Bold className="size-4" /></Toggle>
                  </div>
                </SubSection>
                <SubSection title="Toggle Group (single)">
                  <ToggleGroup type="single" defaultValue="left">
                    <ToggleGroupItem value="left" aria-label="Left"><AlignLeft className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="center" aria-label="Center"><AlignCenter className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="right" aria-label="Right"><AlignRight className="size-4" /></ToggleGroupItem>
                  </ToggleGroup>
                </SubSection>
                <SubSection title="Toggle Group (multiple)">
                  <ToggleGroup type="multiple" defaultValue={['bold', 'italic']}>
                    <ToggleGroupItem value="bold" aria-label="Bold"><Bold className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="italic" aria-label="Italic"><Italic className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="underline" aria-label="Underline"><Underline className="size-4" /></ToggleGroupItem>
                  </ToggleGroup>
                </SubSection>
              </div>
            </Section>

            {/* ─── CARDS ───────────────────────────────────────── */}
            <Section id="cards" title="Cards">
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <Card className="surface-card">
                  <CardHeader>
                    <CardTitle>Themed Card</CardTitle>
                    <CardDescription>Iridescent surface tint.</CardDescription>
                  </CardHeader>
                  <CardContent><p className="text-sm text-muted-foreground">Gradient diagonal wash from palette colors.</p></CardContent>
                </Card>

                <Card className="surface-card">
                  <CardHeader><CardTitle>With Footer</CardTitle><CardDescription>Action buttons.</CardDescription></CardHeader>
                  <CardContent><p className="text-sm text-muted-foreground">Interactive card pattern.</p></CardContent>
                  <CardFooter className="flex gap-2">
                    <Button size="sm" className="gradient-primary border-0 text-white">Save</Button>
                    <Button variant="outline" size="sm">Cancel</Button>
                  </CardFooter>
                </Card>

                <Card className="glass cursor-pointer card-hover">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Glass</CardTitle>
                    <CardDescription>Frosted glass + hover.</CardDescription>
                  </CardHeader>
                  <CardContent><p className="text-sm text-muted-foreground">Translucent over any background.</p></CardContent>
                </Card>

                <Card className="gradient-border gradient-border-animated overflow-hidden surface-card">
                  <CardHeader>
                    <CardTitle className="gradient-primary-text">Animated Border</CardTitle>
                    <CardDescription>Shifting gradient outline.</CardDescription>
                  </CardHeader>
                  <CardContent><p className="text-sm text-muted-foreground">Eye-catching accent card.</p></CardContent>
                </Card>

                <Card className="relative overflow-hidden">
                  <div className="absolute inset-0 gradient-primary opacity-[0.07]" />
                  <CardHeader className="relative">
                    <CardTitle>Strong Tint</CardTitle>
                    <CardDescription>Heavier gradient overlay.</CardDescription>
                  </CardHeader>
                  <CardContent className="relative"><p className="text-sm text-muted-foreground">Featured content.</p></CardContent>
                </Card>
              </div>
            </Section>

            {/* ─── BADGES ──────────────────────────────────────── */}
            <Section id="badges" title="Badges">
              <div className="flex flex-wrap items-center gap-3">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Destructive</Badge>
                <Badge className="bg-success text-success-foreground">Success</Badge>
                <Badge className="bg-warning text-warning-foreground">Warning</Badge>
                <Badge className="bg-info text-info-foreground">Info</Badge>
                <Badge className="gradient-primary text-white border-0">
                  <Sparkles className="size-3" /> Gradient
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-3 mt-3">
                <Badge variant="secondary">Queue: 3</Badge>
                <Badge className="bg-success text-success-foreground">Online</Badge>
                <Badge className="bg-warning text-warning-foreground"><Loader2 className="size-3 animate-spin" /> Processing</Badge>
                <Badge variant="outline">v1.0.0</Badge>
              </div>
            </Section>

            {/* ─── ALERTS ──────────────────────────────────────── */}
            <Section id="alerts" title="Alerts">
              <div className="max-w-2xl space-y-3">
                <Alert>
                  <Info className="size-4" /><AlertTitle>Info</AlertTitle>
                  <AlertDescription>Your Agent is learning from patterns.</AlertDescription>
                </Alert>
                <Alert className="border-success/50 text-success [&>svg]:text-success">
                  <CheckCircle className="size-4" /><AlertTitle>Success</AlertTitle>
                  <AlertDescription>Provider connected.</AlertDescription>
                </Alert>
                <Alert className="border-warning/50 text-warning [&>svg]:text-warning">
                  <AlertTriangle className="size-4" /><AlertTitle>Warning</AlertTitle>
                  <AlertDescription>No embedding provider configured.</AlertDescription>
                </Alert>
                <Alert variant="destructive">
                  <AlertCircle className="size-4" /><AlertTitle>Error</AlertTitle>
                  <AlertDescription>API key invalid.</AlertDescription>
                </Alert>
              </div>
            </Section>

            {/* ─── FORM CONTROLS ───────────────────────────────── */}
            <Section id="form-controls" title="Checkboxes, Radios, Switches">
              <div className="grid gap-5 sm:grid-cols-3">
                <div className="space-y-3 surface-card rounded-xl p-4 border">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Checkboxes</p>
                  <div className="flex items-center gap-2"><Checkbox id="c1" defaultChecked /><Label htmlFor="c1">Checked</Label></div>
                  <div className="flex items-center gap-2"><Checkbox id="c2" /><Label htmlFor="c2">Unchecked</Label></div>
                  <div className="flex items-center gap-2"><Checkbox id="c3" disabled /><Label htmlFor="c3" className="text-muted-foreground">Disabled</Label></div>
                </div>
                <div className="surface-card rounded-xl p-4 border">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Radios</p>
                  <RadioGroup defaultValue="a">
                    <div className="flex items-center gap-2"><RadioGroupItem value="a" id="ra" /><Label htmlFor="ra">Claude</Label></div>
                    <div className="flex items-center gap-2"><RadioGroupItem value="b" id="rb" /><Label htmlFor="rb">GPT-4</Label></div>
                    <div className="flex items-center gap-2"><RadioGroupItem value="c" id="rc" /><Label htmlFor="rc">Gemini</Label></div>
                  </RadioGroup>
                </div>
                <div className="space-y-3 surface-card rounded-xl p-4 border">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Switches</p>
                  <div className="flex items-center gap-2"><Switch id="s1" defaultChecked /><Label htmlFor="s1">Dark mode</Label></div>
                  <div className="flex items-center gap-2"><Switch id="s2" /><Label htmlFor="s2">Notifications</Label></div>
                  <div className="flex items-center gap-2"><Switch id="s3" disabled /><Label htmlFor="s3" className="text-muted-foreground">Disabled</Label></div>
                </div>
              </div>
            </Section>

            {/* ─── DIALOG ──────────────────────────────────────── */}
            <Section id="dialog" title="Dialog / Modal">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Modal dialogs for focused interactions. Glass overlay, animated entrance, multiple styles.
              </p>

              <SubSection title="Form Dialog (Glass)">
                <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                  <DialogTrigger asChild>
                    <Button className="gradient-primary border-0 text-white glow-primary btn-magnetic">
                      <Plus className="size-4" /> Create an Agent
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="surface-card dark:glass-strong">
                    <DialogHeader>
                      <DialogTitle className="gradient-primary-text">Create a new Agent</DialogTitle>
                      <DialogDescription>Give your AI assistant a name and personality.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2"><Label>Name</Label><Input placeholder="e.g. Chef Cuisinier" /></div>
                      <div className="space-y-2"><Label>Role</Label><Input placeholder="e.g. Expert gastronomique" /></div>
                      <div className="space-y-2">
                        <Label>Model</Label>
                        <Select><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="claude">Claude Sonnet 4</SelectItem>
                            <SelectItem value="gpt4">GPT-4o</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                      <Button className="gradient-primary border-0 text-white btn-shine" onClick={() => setDialogOpen(false)}>
                        <Wand2 className="size-4" /> Create
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </SubSection>

              <SubSection title="FormDialog (recommended for forms)">
                <p className="text-sm text-muted-foreground max-w-2xl mb-3">
                  Standard form modal. Fixed header, a single scrollable body, and a
                  separated sticky footer whose submit/cancel buttons never scroll away
                  or overlap the content. Responsive down to ~360px (near-full width on
                  phones, buttons stack). Pair with <code>FormField</code>/<code>FormRow</code>;
                  inputs and selects are full-width by default. Use this instead of
                  hand-assembling Dialog + DialogContent + DialogFooter.
                </p>
                <Button variant="outline" className="btn-press" onClick={() => setFormDialogOpen(true)}>
                  <Plus className="size-4" /> Open FormDialog
                </Button>
                <FormDialog
                  open={formDialogOpen}
                  onOpenChange={setFormDialogOpen}
                  title="Create a new Agent"
                  description="Give your AI assistant a name and personality."
                  size="lg"
                  onSubmit={() => setFormDialogOpen(false)}
                  submitLabel="Create"
                >
                  <FormRow>
                    <FormField label="First name" htmlFor="ds-fd-first">
                      <Input id="ds-fd-first" placeholder="e.g. Chef" />
                    </FormField>
                    <FormField label="Last name" htmlFor="ds-fd-last">
                      <Input id="ds-fd-last" placeholder="e.g. Cuisinier" />
                    </FormField>
                  </FormRow>
                  <FormField label="Role" htmlFor="ds-fd-role" tip="Shown in the Agent's system prompt.">
                    <Input id="ds-fd-role" placeholder="e.g. Expert gastronomique" />
                  </FormField>
                  <FormField label="Model" htmlFor="ds-fd-model">
                    <Select>
                      <SelectTrigger id="ds-fd-model"><SelectValue placeholder="Choose" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">Claude Sonnet 4</SelectItem>
                        <SelectItem value="gpt4">GPT-4o</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                </FormDialog>
              </SubSection>

              <SubSection title="Success Dialog">
                <Dialog open={dialogSuccessOpen} onOpenChange={setDialogSuccessOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" className="btn-press"><CheckCircle className="size-4" /> Success Dialog</Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md text-center">
                    <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-success/10 mb-2">
                      <CheckCircle className="size-8 text-success" />
                    </div>
                    <DialogHeader className="sm:text-center">
                      <DialogTitle>Agent Created Successfully!</DialogTitle>
                      <DialogDescription>
                        Your new Agent "Financial Advisor" is ready. You can start chatting now.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="sm:justify-center pt-2">
                      <Button className="gradient-primary border-0 text-white btn-shine" onClick={() => setDialogSuccessOpen(false)}>
                        <Sparkles className="size-4" /> Start Chatting
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </SubSection>

              <SubSection title="Alert Dialog (Destructive)">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" className="btn-press"><Trash2 className="size-4" /> Delete Agent</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <div className="mx-auto sm:mx-0 flex size-12 items-center justify-center rounded-full bg-destructive/10 mb-1">
                        <AlertTriangle className="size-6 text-destructive" />
                      </div>
                      <AlertDialogTitle>Delete "Financial Advisor"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. All memories, conversations, and settings associated with this Agent will be permanently deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive">
                        <Trash2 className="size-4" /> Delete Permanently
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </SubSection>

              <SubSection title="Compact Dialog">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="btn-press"><ShieldCheck className="size-4" /> Confirm Action</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader className="text-center">
                      <AlertDialogTitle>Enable Auto-Compact?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Messages will be automatically summarized when token limits are reached.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Not now</AlertDialogCancel>
                      <AlertDialogAction className="gradient-primary border-0 text-white">Enable</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </SubSection>
            </Section>

            {/* ─── SHEET ───────────────────────────────────────── */}
            <Section id="sheet" title="Sheet / Drawer">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Slide-in panels from any edge. Great for settings, navigation, and detail views.
              </p>
              <div className="flex flex-wrap gap-3">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" className="btn-press"><PanelRight className="size-4" /> Right Sheet</Button>
                  </SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle className="gradient-primary-text">Agent Settings</SheetTitle>
                      <SheetDescription>Configure your Agent's behavior and appearance.</SheetDescription>
                    </SheetHeader>
                    <div className="space-y-4 p-4 flex-1">
                      <div className="space-y-2"><Label>Display Name</Label><Input defaultValue="Financial Advisor" /></div>
                      <div className="space-y-2"><Label>System Prompt</Label><Textarea rows={4} defaultValue="You are a helpful financial advisor..." /></div>
                      <div className="flex items-center gap-2"><Switch defaultChecked /><Label>Auto-compact messages</Label></div>
                      <div className="flex items-center gap-2"><Switch /><Label>Allow tool execution</Label></div>
                    </div>
                    <SheetFooter>
                      <SheetClose asChild><Button variant="outline">Cancel</Button></SheetClose>
                      <Button className="gradient-primary border-0 text-white btn-shine">Save Changes</Button>
                    </SheetFooter>
                  </SheetContent>
                </Sheet>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" className="btn-press"><PanelLeftClose className="size-4" /> Left Sheet</Button>
                  </SheetTrigger>
                  <SheetContent side="left">
                    <SheetHeader>
                      <SheetTitle>Navigation</SheetTitle>
                      <SheetDescription>Mobile sidebar example.</SheetDescription>
                    </SheetHeader>
                    <div className="space-y-1 p-4">
                      {[
                        { label: 'Dashboard', icon: BarChart3, active: true },
                        { label: 'Agents', icon: Bot, active: false },
                        { label: 'Memories', icon: Sparkles, active: false },
                        { label: 'Settings', icon: Settings, active: false },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className={cn(
                            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer transition-colors',
                            item.active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'
                          )}
                        >
                          <item.icon className="size-4" />
                          {item.label}
                        </div>
                      ))}
                    </div>
                  </SheetContent>
                </Sheet>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" className="btn-press"><ChevronDown className="size-4 rotate-180" /> Top Sheet</Button>
                  </SheetTrigger>
                  <SheetContent side="top">
                    <SheetHeader className="text-center">
                      <SheetTitle className="gradient-primary-text">Quick Actions</SheetTitle>
                      <SheetDescription>Jump to common tasks.</SheetDescription>
                    </SheetHeader>
                    <div className="flex flex-wrap justify-center gap-3 p-4">
                      <Button variant="outline" size="sm" className="btn-press"><Plus className="size-4" /> New Agent</Button>
                      <Button variant="outline" size="sm" className="btn-press"><Search className="size-4" /> Search</Button>
                      <Button variant="outline" size="sm" className="btn-press"><Settings className="size-4" /> Settings</Button>
                      <Button variant="outline" size="sm" className="btn-press"><Bell className="size-4" /> Notifications</Button>
                    </div>
                  </SheetContent>
                </Sheet>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" className="btn-press"><ChevronDown className="size-4" /> Bottom Sheet</Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="rounded-t-2xl">
                    <SheetHeader className="text-center">
                      <SheetTitle>Share Conversation</SheetTitle>
                      <SheetDescription>Choose how to share this conversation.</SheetDescription>
                    </SheetHeader>
                    <div className="grid grid-cols-3 gap-3 p-4 max-w-sm mx-auto">
                      {[
                        { label: 'Copy Link', icon: Copy },
                        { label: 'Export', icon: ExternalLink },
                        { label: 'Delete', icon: Trash2 },
                      ].map((action) => (
                        <button
                          key={action.label}
                          className="flex flex-col items-center gap-2 rounded-xl p-4 hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex size-10 items-center justify-center rounded-full bg-secondary">
                            <action.icon className="size-5 text-secondary-foreground" />
                          </div>
                          <span className="text-xs font-medium">{action.label}</span>
                        </button>
                      ))}
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            </Section>

            {/* ─── POPOVER ─────────────────────────────────────── */}
            <Section id="popover" title="Popover">
              <div className="flex flex-wrap gap-3">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline"><Settings className="size-4" /> Quick Settings</Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-medium text-sm">Model Settings</h4>
                        <p className="text-xs text-muted-foreground">Configure the AI model parameters.</p>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">Temperature</Label>
                          <span className="text-xs text-muted-foreground">0.7</span>
                        </div>
                        <Progress value={70} />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">Max Tokens</Label>
                          <span className="text-xs text-muted-foreground">4096</span>
                        </div>
                        <Progress value={50} />
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch defaultChecked />
                        <Label className="text-sm">Stream responses</Label>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline"><BarChart3 className="size-4" /> Status</Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-3">
                      <h4 className="font-medium text-sm">System Status</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">API</span>
 <Badge size="xs" className="bg-success text-success-foreground">Healthy</Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Database</span>
 <Badge size="xs" className="bg-success text-success-foreground">Connected</Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Queue</span>
 <Badge variant="secondary" size="xs">3 pending</Badge>
                        </div>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </Section>

            {/* ─── TABS, DROPDOWN, TOOLTIP ─────────────────────── */}
            <Section id="tabs-dropdown" title="Tabs, Dropdown, Tooltip">
              <div className="grid gap-8 lg:grid-cols-2">
                <SubSection title="Tabs">
                  <Tabs defaultValue="chat">
                    <TabsList>
                      <TabsTrigger value="chat">Chat</TabsTrigger>
                      <TabsTrigger value="memory">Memory</TabsTrigger>
                      <TabsTrigger value="tools">Tools</TabsTrigger>
                    </TabsList>
                    <TabsContent value="chat" className="mt-3 surface-card rounded-lg p-4 border text-sm text-muted-foreground">Streaming chat interface.</TabsContent>
                    <TabsContent value="memory" className="mt-3 surface-card rounded-lg p-4 border text-sm text-muted-foreground">Semantic memory search.</TabsContent>
                    <TabsContent value="tools" className="mt-3 surface-card rounded-lg p-4 border text-sm text-muted-foreground">MCP and custom tools.</TabsContent>
                  </Tabs>
                </SubSection>
                <div className="space-y-6">
                  <SubSection title="Dropdown">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="outline"><MoreHorizontal className="size-4" /> Actions</Button></DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem><Pencil className="mr-2 size-4" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem><Copy className="mr-2 size-4" /> Duplicate</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive"><Trash2 className="mr-2 size-4" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SubSection>
                  <SubSection title="Tooltips">
                    <div className="flex gap-3">
                      {[{ icon: Settings, label: 'Settings' }, { icon: Bell, label: 'Notifications' }, { icon: Info, label: 'Info' }].map(({ icon: Icon, label }) => (
                        <Tooltip key={label}>
                          <TooltipTrigger asChild><Button variant="outline" size="icon"><Icon className="size-4" /></Button></TooltipTrigger>
                          <TooltipContent>{label}</TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </SubSection>
                </div>
              </div>
            </Section>

            {/* ─── COMMAND ─────────────────────────────────────── */}
            <Section id="command" title="Command Palette">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Search, navigate, and execute actions quickly. Used for Cmd+K search and navigation.
              </p>
              <div className="max-w-lg">
                <Command className="rounded-xl border shadow-md">
                  <CommandInput placeholder="Search agents, memories, settings..." />
                  <CommandList>
                    <CommandEmpty>No results found.</CommandEmpty>
                    <CommandGroup heading="Agents">
                      <CommandItem>
                        <Bot className="mr-2 size-4" /> Financial Advisor
                      </CommandItem>
                      <CommandItem>
                        <Bot className="mr-2 size-4" /> Coding Assistant
                      </CommandItem>
                      <CommandItem>
                        <Bot className="mr-2 size-4" /> Research Agent
                      </CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="Navigation">
                      <CommandItem>
                        <Settings className="mr-2 size-4" /> Settings
                      </CommandItem>
                      <CommandItem>
                        <User className="mr-2 size-4" /> My Account
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </div>
            </Section>

            {/* ─── BREADCRUMB ─────────────────────────────────── */}
            <Section id="breadcrumb" title="Breadcrumb">
              <div className="space-y-4">
                <SubSection title="Default">
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#"><Home className="size-4" /></BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#">Settings</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>Providers</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </SubSection>
                <SubSection title="With icons">
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#" className="flex items-center gap-1.5"><Home className="size-3.5" /> Home</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator>
                        <ChevronRight className="size-3.5" />
                      </BreadcrumbSeparator>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#" className="flex items-center gap-1.5"><Bot className="size-3.5" /> Agents</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator>
                        <ChevronRight className="size-3.5" />
                      </BreadcrumbSeparator>
                      <BreadcrumbItem>
                        <BreadcrumbPage className="flex items-center gap-1.5"><FileText className="size-3.5" /> Financial Advisor</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </SubSection>
              </div>
            </Section>

            {/* ─── PROGRESS ────────────────────────────────────── */}
            <Section id="progress" title="Progress">
              <div className="max-w-lg space-y-6">
                <SubSection title="Interactive">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span>Token usage</span>
                        <span className="text-muted-foreground">{progressVal}%</span>
                      </div>
                      <Progress value={progressVal} variant="gradient" className="h-2.5" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="xs" variant="outline" className="btn-press" onClick={() => setProgressVal(Math.max(0, progressVal - 10))}>-10</Button>
                      <Button size="xs" variant="outline" className="btn-press" onClick={() => setProgressVal(Math.min(100, progressVal + 10))}>+10</Button>
                      <Button size="xs" variant="outline" className="btn-press" onClick={() => setProgressVal(100)}>Full</Button>
                      <Button size="xs" variant="outline" className="btn-press" onClick={() => setProgressVal(0)}>Reset</Button>
                    </div>
                  </div>
                </SubSection>
                <SubSection title="Variants">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Default</span>
                      <Progress value={65} />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Gradient</span>
                      <Progress value={72} variant="gradient" />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Glow</span>
                      <Progress value={58} variant="glow" className="h-2.5" />
                    </div>
                  </div>
                </SubSection>
                <SubSection title="Active (Animated)">
                  <p className="text-xs text-muted-foreground mb-3">
                    A shimmer sweeps through the filled area to indicate ongoing activity.
                  </p>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Default + active</span>
                      <Progress value={60} active />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Gradient + active</span>
                      <Progress value={45} variant="gradient" className="h-2.5" active />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Glow + active</span>
                      <Progress value={72} variant="glow" className="h-3" active />
                    </div>
                  </div>
                </SubSection>
                <SubSection title="Sizes">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Thin (h-1)</span>
                      <Progress value={80} variant="gradient" className="h-1" />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Default (h-2)</span>
                      <Progress value={65} variant="gradient" />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Medium (h-2.5)</span>
                      <Progress value={45} variant="gradient" className="h-2.5" />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Thick (h-3)</span>
                      <Progress value={72} variant="glow" className="h-3" />
                    </div>
                  </div>
                </SubSection>
              </div>
            </Section>

            {/* ─── SCROLL AREA ─────────────────────────────────── */}
            <Section id="scroll-area" title="Scroll Area">
              <div className="grid gap-6 sm:grid-cols-2">
                <SubSection title="Vertical scroll">
                  <ScrollArea className="h-48 rounded-xl border surface-card p-4">
                    <div className="space-y-3">
                      {Array.from({ length: 20 }, (_, i) => (
                        <div key={i} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent/30 transition-colors">
                          <Avatar className="size-8">
                            <AvatarFallback className="gradient-primary text-white text-xs">
                              {String.fromCharCode(65 + (i % 26))}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">Memory #{i + 1}</p>
                            <p className="text-xs text-muted-foreground">Extracted from conversation</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </SubSection>
                <SubSection title="Chat messages scroll">
                  <ScrollArea className="h-48 rounded-xl border surface-chat p-4">
                    <div className="space-y-3">
                      {['How are you?', 'I need help with finances', 'What about my subscriptions?', 'Can you track expenses?', 'Show me a summary', 'What are the trends?', 'Any recommendations?', 'Thanks!'].map((msg, i) => (
                        <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${i % 2 === 0 ? 'gradient-primary text-white rounded-br-md' : 'bg-bubble-agent text-bubble-agent-foreground rounded-bl-md'}`}>
                            {msg}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </SubSection>
              </div>
            </Section>

            {/* ─── COLLAPSIBLE ──────────────────────────────────── */}
            <Section id="collapsible" title="Collapsible">
              <div className="max-w-lg space-y-3">
                <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen}>
                  <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Bot className="size-4 text-primary" />
                      <span className="text-sm font-medium">Advanced Settings</span>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="icon-xs">
                        <ChevronDown className={`size-4 transition-transform ${collapsibleOpen ? 'rotate-180' : ''}`} />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
                    <div className="space-y-3 rounded-lg border border-t-0 rounded-t-none bg-card/50 p-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Enable memory extraction</Label>
                        <Switch defaultChecked />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Auto-compact threshold</Label>
                        <span className="text-sm text-muted-foreground">80%</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Max sub-agent depth</Label>
                        <span className="text-sm text-muted-foreground">3</span>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <Collapsible defaultOpen>
                  <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-4 text-primary" />
                      <span className="text-sm font-medium">Model Configuration</span>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="icon-xs">
                        <ChevronsUpDown className="size-4" />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
                    <div className="space-y-3 rounded-lg border border-t-0 rounded-t-none bg-card/50 p-4">
                      <div className="space-y-2">
                        <Label className="text-sm">Provider</Label>
                        <Select defaultValue="anthropic">
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                            <SelectItem value="openai">OpenAI</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </Section>

            {/* ─── TOAST ───────────────────────────────────────── */}
            <Section id="toast" title="Toast Notifications">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Styled toasts with semantic colors, glass blur, and smooth animations. Powered by Sonner.
              </p>

              <div className="grid gap-8 sm:grid-cols-2">
                <SubSection title="Semantic Types">
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => toast('Default notification', { description: 'Something happened in the system.' })}>
                      Default
                    </Button>
                    <Button variant="outline" onClick={() => toast.success('Agent created', { description: 'Financial Advisor is ready to chat.' })}>
                      <CheckCircle className="size-4 text-success" /> Success
                    </Button>
                    <Button variant="outline" onClick={() => toast.error('Connection failed', { description: 'Check your API key and try again.' })}>
                      <AlertCircle className="size-4 text-destructive" /> Error
                    </Button>
                    <Button variant="outline" onClick={() => toast.warning('Token limit near', { description: 'Compacting will trigger soon.' })}>
                      <AlertTriangle className="size-4 text-warning" /> Warning
                    </Button>
                    <Button variant="outline" onClick={() => toast.info('Pro tip', { description: 'Use @mention to invoke other Agents in conversation.' })}>
                      <Info className="size-4 text-info" /> Info
                    </Button>
                    <Button variant="outline" onClick={() => toast.loading('Processing...', { description: 'Analyzing your data.' })}>
                      <Loader2 className="size-4 animate-spin" /> Loading
                    </Button>
                  </div>
                </SubSection>

                <SubSection title="With Actions">
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => toast('Agent deleted', { description: 'Financial Advisor has been removed.', action: { label: 'Undo', onClick: () => toast.success('Restored!', { description: 'Agent has been restored.' }) } })}>
                      Action Button
                    </Button>
                    <Button variant="outline" onClick={() => toast('Session exported', { description: 'conversation-2024.json saved.', cancel: { label: 'Dismiss', onClick: () => {} } })}>
                      Cancel Button
                    </Button>
                    <Button variant="outline" onClick={() => toast.success('Memory saved', { description: '3 new memories extracted.', action: { label: 'View', onClick: () => toast.info('Opening memories...') }, cancel: { label: 'Dismiss', onClick: () => {} } })}>
                      Both Buttons
                    </Button>
                  </div>
                </SubSection>

                <SubSection title="Promise (Async)">
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => {
                      toast.promise(
                        new Promise<{ name: string }>((resolve) => setTimeout(() => resolve({ name: 'Financial Advisor' }), 2000)),
                        {
                          loading: 'Creating Agent...',
                          success: (data) => `${data.name} is ready!`,
                          error: 'Failed to create Agent',
                        }
                      )
                    }}>
                      <Loader2 className="size-4" /> Promise Toast
                    </Button>
                    <Button variant="outline" onClick={() => {
                      toast.promise(
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
                        {
                          loading: 'Connecting to provider...',
                          success: 'Connected!',
                          error: 'Connection timed out',
                        }
                      )
                    }}>
                      <AlertCircle className="size-4" /> Promise (Fail)
                    </Button>
                  </div>
                </SubSection>

                <SubSection title="Rich Content">
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => toast('Scheduled job completed', { description: 'Daily report generated at 09:00 AM. 3 Agents participated, 12 tasks executed.', duration: 6000 })}>
                      Long Description
                    </Button>
                    <Button variant="outline" onClick={() => toast.success('Memory extracted', { description: 'User prefers dark mode with Aurora palette. Saved to long-term memory.', duration: 5000 })}>
                      <Star className="size-4 text-warning" /> Rich Success
                    </Button>
                  </div>
                </SubSection>
              </div>
            </Section>

            {/* ─── AVATARS ─────────────────────────────────────── */}
            <Section id="avatars" title="Avatars">
              <div className="grid gap-8 sm:grid-cols-2">
                <SubSection title="Sizes">
                  <div className="flex items-end gap-4">
                    {[
                      { s: 'size-6', t: 'text-[10px]', l: 'XS' }, { s: 'size-8', t: 'text-xs', l: 'SM' },
                      { s: 'size-10', t: 'text-sm', l: 'MD' }, { s: 'size-12', t: 'text-base', l: 'LG' },
                      { s: 'size-16', t: 'text-lg', l: 'XL' },
                    ].map((i) => (
                      <div key={i.l} className="flex flex-col items-center gap-1.5">
                        <Avatar className={i.s}><AvatarFallback className={`gradient-primary text-white ${i.t}`}>KB</AvatarFallback></Avatar>
                        <span className="text-xs text-muted-foreground">{i.l}</span>
                      </div>
                    ))}
                  </div>
                </SubSection>
                <SubSection title="Status">
                  <div className="flex items-center gap-6">
                    {[
                      { st: 'Online', c: 'bg-success' }, { st: 'Offline', c: 'bg-muted-foreground' }, { st: 'Busy', c: 'bg-warning animate-pulse' },
                    ].map((i) => (
                      <div key={i.st} className="flex flex-col items-center gap-1.5">
                        <div className="relative">
                          <Avatar className="size-10"><AvatarFallback className="gradient-primary text-white"><Bot className="size-5" /></AvatarFallback></Avatar>
                          <span className={`absolute bottom-0 right-0 size-3 rounded-full border-2 border-background ${i.c}`} />
                        </div>
                        <span className="text-xs text-muted-foreground">{i.st}</span>
                      </div>
                    ))}
                  </div>
                </SubSection>
              </div>
            </Section>

            {/* ─── ANIMATIONS ─────────────────────────────────── */}
            <Section id="animations" title="Animations & Effects">
              <p className="text-sm text-muted-foreground max-w-2xl">
                Micro-interactions, hover effects, and fancy animations. All respect <code className="text-xs bg-muted px-1.5 py-0.5 rounded">prefers-reduced-motion</code>.
              </p>

              <SubSection title="Button Effects">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex flex-col items-center gap-2">
                    <Button className="gradient-primary border-0 text-white btn-shine">
                      <Sparkles className="size-4" /> Shine Sweep
                    </Button>
                    <span className="text-[10px] text-muted-foreground">.btn-shine</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button className="gradient-primary border-0 text-white btn-magnetic">
                      <Rocket className="size-4" /> Magnetic
                    </Button>
                    <span className="text-[10px] text-muted-foreground">.btn-magnetic</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="outline" className="btn-press">
                      <MousePointer className="size-4" /> Press
                    </Button>
                    <span className="text-[10px] text-muted-foreground">.btn-press</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button className="gradient-primary border-0 text-white btn-ripple">
                      <Zap className="size-4" /> Ripple
                    </Button>
                    <span className="text-[10px] text-muted-foreground">.btn-ripple</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="outline" className="btn-jelly">
                      <Star className="size-4" /> Jelly
                    </Button>
                    <span className="text-[10px] text-muted-foreground">.btn-jelly</span>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Glow & Border Effects">
                <div className="flex flex-wrap items-center gap-5">
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-20 items-center justify-center rounded-xl border bg-card pulse-glow">
                      <Crown className="size-8 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.pulse-glow</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-20 items-center justify-center rounded-xl bg-card hover-glow cursor-pointer">
                      <Sparkles className="size-8 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.hover-glow</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-20 items-center justify-center rounded-xl bg-card gradient-border gradient-border-animated">
                      <Wand2 className="size-8 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.gradient-border-animated</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-20 items-center justify-center rounded-xl bg-card gradient-border-spin">
                      <Star className="size-8 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.gradient-border-spin</span>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Text Effects">
                <div className="space-y-3">
                  <h3 className="text-3xl font-bold text-shimmer">Shimmer Gradient Text</h3>
                  <h3 className="text-3xl font-bold gradient-primary-text">Static Gradient Text</h3>
                </div>
              </SubSection>

              <SubSection title="Motion">
                <div className="flex flex-wrap items-end gap-6">
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-16 items-center justify-center rounded-xl bg-card border animate-levitate">
                      <Bot className="size-6 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.animate-levitate</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-16 items-center justify-center rounded-xl bg-card border animate-fade-in-up">
                      <Zap className="size-6 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.animate-fade-in-up</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex size-16 items-center justify-center rounded-xl bg-card border animate-scale-in">
                      <Heart className="size-6 text-primary" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.animate-scale-in</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-xl bg-card border px-4 py-3">
                      <span className="size-2 rounded-full bg-primary animate-typing-dot" />
                      <span className="size-2 rounded-full bg-primary animate-typing-dot delay-1" />
                      <span className="size-2 rounded-full bg-primary animate-typing-dot delay-2" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">.animate-typing-dot</span>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Card Interactions">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Card className="card-hover cursor-pointer surface-card">
                    <CardContent className="p-5 text-center">
                      <Zap className="mx-auto size-8 text-primary mb-2" />
                      <p className="text-sm font-medium">Hover Lift</p>
                      <p className="text-xs text-muted-foreground mt-1">.card-hover</p>
                    </CardContent>
                  </Card>
                  <Card className="hover-glow cursor-pointer surface-card transition-all">
                    <CardContent className="p-5 text-center">
                      <Sparkles className="mx-auto size-8 text-primary mb-2" />
                      <p className="text-sm font-medium">Glow on Hover</p>
                      <p className="text-xs text-muted-foreground mt-1">.hover-glow</p>
                    </CardContent>
                  </Card>
                  <Card className="gradient-border-spin overflow-hidden surface-card">
                    <CardContent className="p-5 text-center">
                      <Star className="mx-auto size-8 text-primary mb-2" />
                      <p className="text-sm font-medium">Spinning Border</p>
                      <p className="text-xs text-muted-foreground mt-1">.gradient-border-spin</p>
                    </CardContent>
                  </Card>
                </div>
              </SubSection>

              <SubSection title="Skeleton Shimmer">
                <div className="max-w-sm space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="skeleton size-10 rounded-full shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="skeleton h-4 w-3/4 rounded" />
                      <div className="skeleton h-3 w-1/2 rounded" />
                    </div>
                  </div>
                  <div className="skeleton h-32 w-full rounded-xl" />
                  <div className="space-y-2">
                    <div className="skeleton h-3 w-full rounded" />
                    <div className="skeleton h-3 w-5/6 rounded" />
                    <div className="skeleton h-3 w-2/3 rounded" />
                  </div>
                </div>
              </SubSection>
            </Section>

            {/* ─── GEZY PATTERNS ──────────────────────────────── */}
            <Section id="gezy-patterns" title="Gezy Patterns">

              <SubSection title="Chat Bubbles">
                <div className="max-w-2xl space-y-4 surface-chat rounded-xl p-6 border">
                  {/* User */}
                  <div className="flex justify-end gap-2.5">
                    <div className="max-w-[75%] space-y-1">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-muted-foreground">Nicolas</span>
                        <span className="text-xs text-muted-foreground">14:32</span>
                      </div>
                      <div className="gradient-primary rounded-2xl rounded-br-md px-4 py-2.5 text-white shadow-sm">
                        <p className="text-sm">Can you analyze my monthly expenses?</p>
                      </div>
                    </div>
                    <Avatar className="size-8 shrink-0"><AvatarFallback className="bg-secondary text-xs"><User className="size-4" /></AvatarFallback></Avatar>
                  </div>
                  {/* Agent */}
                  <div className="flex gap-2.5">
                    <Avatar className="size-8 shrink-0"><AvatarFallback className="gradient-primary text-white text-xs"><Bot className="size-4" /></AvatarFallback></Avatar>
                    <div className="max-w-[75%] space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">Financial Advisor</span>
                        <span className="text-xs text-muted-foreground">14:33</span>
                      </div>
                      <div className="rounded-2xl rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm">
                        <p className="text-sm">Sure! I see three optimization areas: subscriptions, dining, and transport.</p>
                      </div>
                    </div>
                  </div>
                  {/* System */}
                  <div className="flex justify-center">
                    <div className="flex items-center gap-1.5 rounded-full bg-bubble-system px-4 py-1.5 text-bubble-system-foreground">
                      <CheckCircle className="size-3" /><p className="text-xs">Task completed</p>
                    </div>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Agent Cards — Current">
                <p className="text-sm text-muted-foreground mb-3">Current horizontal card with left avatar strip.</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {/* Active / selected agent */}
                  <div className="group relative flex overflow-hidden rounded-xl border border-primary/30 bg-card shadow-md card-hover">
                    <div className="w-20 shrink-0 gradient-primary flex items-center justify-center">
                      <Bot className="size-8 text-white/90" />
                    </div>
                    <div className="flex flex-1 flex-col justify-center gap-1 p-3 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold">Financial Advisor</p>
 <Badge variant="secondary" size="xs" className="shrink-0">2</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">Personal finance expert</p>
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full bg-success" />
                          <span className="text-[10px] text-muted-foreground">Online</span>
                        </div>
                        <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />Claude Sonnet</span>
                      </div>
                    </div>
                  </div>

                  {/* Idle agent */}
                  <div className="group relative flex overflow-hidden rounded-xl border bg-card card-hover cursor-pointer">
                    <div className="w-20 shrink-0 bg-secondary flex items-center justify-center">
                      <Bot className="size-8 text-secondary-foreground/70" />
                    </div>
                    <div className="flex flex-1 flex-col justify-center gap-1 p-3 min-w-0">
                      <p className="truncate text-sm font-medium">Coding Assistant</p>
                      <p className="truncate text-xs text-muted-foreground">Full-stack developer</p>
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full bg-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground">Offline</span>
                        </div>
                        <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />GPT-4o</span>
                      </div>
                    </div>
                  </div>

                  {/* Processing agent */}
                  <div className="group relative flex overflow-hidden rounded-xl border border-warning/30 bg-card card-hover cursor-pointer">
                    <div className="w-20 shrink-0 bg-gradient-to-b from-primary/80 to-accent/80 flex items-center justify-center">
                      <Bot className="size-8 text-white/90" />
                    </div>
                    <div className="flex flex-1 flex-col justify-center gap-1 p-3 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">Research Agent</p>
 <Badge size="xs" className="shrink-0 bg-warning text-warning-foreground">
                          <Loader2 className="size-3 animate-spin" />
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">Deep web analysis</p>
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full bg-warning animate-pulse" />
                          <span className="text-[10px] text-muted-foreground">Processing...</span>
                        </div>
                        <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />Gemini Pro</span>
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              {/* ═══════════════════════════════════════════════════ */}
              {/* PROPOSAL A — Compact Minimal Row                   */}
              {/* ═══════════════════════════════════════════════════ */}
              <SubSection title="Proposal A — Compact Minimal Row">
                <p className="text-sm text-muted-foreground mb-3">
                  Slim single-row items with small circular avatar, left accent bar for selected state, and inline status dot. Maximizes vertical density.
                </p>
                <div className="max-w-xs space-y-1 rounded-xl border bg-sidebar p-2">
                  {/* Selected */}
                  <div className="group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer bg-primary/10 transition-colors">
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[3px] rounded-full gradient-primary" />
                    <div className="relative size-8 shrink-0 rounded-full gradient-primary flex items-center justify-center shadow-sm">
                      <Bot className="size-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-semibold">Financial Advisor</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Personal finance expert</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Sonnet</span>
                      </div>
                    </div>
 <Badge variant="secondary" size="xs" className="shrink-0">2</Badge>
                  </div>

                  {/* Idle */}
                  <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-accent/40 transition-colors">
                    <div className="relative size-8 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4 text-secondary-foreground/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Coding Assistant</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Full-stack developer</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· GPT-4o</span>
                      </div>
                    </div>
                  </div>

                  {/* Processing */}
                  <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-accent/40 transition-colors">
                    <div className="relative size-8 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4 text-secondary-foreground/70" />
                      <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-sidebar bg-warning animate-pulse" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Research Agent</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Deep web analysis</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Gemini</span>
                      </div>
                    </div>
                    <Loader2 className="size-3.5 shrink-0 text-primary animate-spin" />
                  </div>

                  {/* Unavailable */}
                  <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-accent/40 transition-colors opacity-60">
                    <div className="relative size-8 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4 text-secondary-foreground/70" />
                      <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-sidebar bg-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Writing Coach</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Creative writing</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Opus</span>
                      </div>
                    </div>
                    <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                  </div>
                </div>
              </SubSection>

              {/* ═══════════════════════════════════════════════════ */}
              {/* PROPOSAL B — Glass Pill                            */}
              {/* ═══════════════════════════════════════════════════ */}
              <SubSection title="Proposal B — Glass Pill">
                <p className="text-sm text-muted-foreground mb-3">
                  Rounded pill-shaped items with glass morphism backdrop. Selected state uses gradient border spin. Processing state pulses.
                </p>
                <div className="max-w-xs space-y-2 rounded-xl border bg-sidebar p-3">
                  {/* Selected */}
                  <div className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 cursor-pointer glass-strong gradient-border-spin transition-all">
                    <div className="size-9 shrink-0 rounded-full gradient-primary flex items-center justify-center shadow-md">
                      <Bot className="size-4.5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-semibold">Financial Advisor</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Personal finance expert</p>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] text-muted-foreground">Sonnet</span>
                      </div>
                    </div>
 <Badge variant="secondary" size="xs" className="shrink-0 rounded-full">2</Badge>
                  </div>

                  {/* Idle */}
                  <div className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-all border border-transparent">
                    <div className="size-9 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4.5 text-secondary-foreground/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Coding Assistant</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Full-stack developer</p>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] text-muted-foreground">GPT-4o</span>
                      </div>
                    </div>
                  </div>

                  {/* Processing */}
                  <div className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 cursor-pointer glass pulse-glow transition-all border border-transparent">
                    <div className="relative size-9 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4.5 text-secondary-foreground/70" />
                      <span className="absolute inset-0 rounded-full border-2 border-t-primary border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Research Agent</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-primary font-medium">Thinking...</p>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] text-muted-foreground">Gemini</span>
                      </div>
                    </div>
                  </div>

                  {/* Idle 2 */}
                  <div className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-all border border-transparent">
                    <div className="size-9 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-4.5 text-secondary-foreground/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Writing Coach</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Creative writing</p>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] text-muted-foreground">Opus</span>
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              {/* ═══════════════════════════════════════════════════ */}
              {/* PROPOSAL C — Stacked Tile (Avatar Focused)         */}
              {/* ═══════════════════════════════════════════════════ */}
              <SubSection title="Proposal C — Stacked Tile (Avatar Focused)">
                <p className="text-sm text-muted-foreground mb-3">
                  Vertical tiles with large centered avatar. Great for visual identity. Works well in a grid or scrollable row. Selected state uses glow + gradient border.
                </p>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {/* Selected */}
                  <div className="group flex flex-col items-center gap-2 rounded-2xl p-4 pb-3 cursor-pointer surface-card gradient-border glow-primary min-w-[110px] transition-all">
                    <div className="size-14 rounded-full gradient-primary flex items-center justify-center shadow-lg">
                      <Bot className="size-7 text-white" />
                    </div>
                    <div className="text-center min-w-0 w-full">
                      <p className="truncate text-xs font-semibold">Financial Advisor</p>
                      <p className="truncate text-[10px] text-muted-foreground mt-0.5">Finance expert</p>
                    </div>
                    <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />Sonnet</span>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 rounded-full">2 in queue</Badge>
                  </div>

                  {/* Idle */}
                  <div className="group flex flex-col items-center gap-2 rounded-2xl p-4 pb-3 cursor-pointer border border-transparent hover:border-border hover:shadow-md min-w-[110px] transition-all">
                    <div className="size-14 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-7 text-secondary-foreground/70" />
                    </div>
                    <div className="text-center min-w-0 w-full">
                      <p className="truncate text-xs font-medium">Coding Assistant</p>
                      <p className="truncate text-[10px] text-muted-foreground mt-0.5">Developer</p>
                    </div>
                    <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />GPT-4o</span>
                  </div>

                  {/* Processing */}
                  <div className="group flex flex-col items-center gap-2 rounded-2xl p-4 pb-3 cursor-pointer border border-transparent hover:border-border min-w-[110px] transition-all">
                    <div className="relative size-14 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-7 text-secondary-foreground/70" />
                      <svg className="absolute inset-0 size-14 animate-spin" style={{ animationDuration: '2s' }}>
                        <circle cx="28" cy="28" r="26" fill="none" stroke="url(#grad-ring)" strokeWidth="2.5" strokeDasharray="40 120" strokeLinecap="round" />
                        <defs>
                          <linearGradient id="grad-ring" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="var(--color-gradient-start)" />
                            <stop offset="50%" stopColor="var(--color-gradient-mid)" />
                            <stop offset="100%" stopColor="var(--color-gradient-end)" />
                          </linearGradient>
                        </defs>
                      </svg>
                    </div>
                    <div className="text-center min-w-0 w-full">
                      <p className="truncate text-xs font-medium">Research Agent</p>
                      <p className="truncate text-[10px] text-primary font-medium mt-0.5">Thinking...</p>
                    </div>
                    <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />Gemini</span>
                  </div>

                  {/* Idle 2 */}
                  <div className="group flex flex-col items-center gap-2 rounded-2xl p-4 pb-3 cursor-pointer border border-transparent hover:border-border hover:shadow-md min-w-[110px] transition-all">
                    <div className="size-14 rounded-full bg-secondary flex items-center justify-center">
                      <Bot className="size-7 text-secondary-foreground/70" />
                    </div>
                    <div className="text-center min-w-0 w-full">
                      <p className="truncate text-xs font-medium">Writing Coach</p>
                      <p className="truncate text-[10px] text-muted-foreground mt-0.5">Creative writing</p>
                    </div>
                    <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70"><Sparkles className="size-2.5" />Opus</span>
                  </div>
                </div>
              </SubSection>

              {/* ═══════════════════════════════════════════════════ */}
              {/* PROPOSAL D — Gradient Accent Line                  */}
              {/* ═══════════════════════════════════════════════════ */}
              <SubSection title="Proposal D — Gradient Accent Line">
                <p className="text-sm text-muted-foreground mb-3">
                  Ultra-clean rows with a gradient left accent stripe. No background change on selected — only the accent line and text weight communicate state. Very sidebar-native.
                </p>
                <div className="max-w-xs space-y-0.5 rounded-xl border bg-sidebar p-2">
                  {/* Selected */}
                  <div className="group relative flex items-center gap-3 rounded-lg pl-4 pr-3 py-2.5 cursor-pointer transition-colors">
                    <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full gradient-primary" />
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="gradient-primary text-white text-[10px] font-bold">FA</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold gradient-primary-text">Financial Advisor</p>
 <Badge variant="secondary" size="xs" className="shrink-0">2</Badge>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Personal finance expert</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Sonnet</span>
                      </div>
                    </div>
                    <Settings2 className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>

                  {/* Idle */}
                  <div className="group relative flex items-center gap-3 rounded-lg pl-4 pr-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors">
                    <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-transparent" />
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="bg-secondary text-secondary-foreground text-[10px] font-bold">CA</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Coding Assistant</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Full-stack developer</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· GPT-4o</span>
                      </div>
                    </div>
                    <Settings2 className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>

                  {/* Processing */}
                  <div className="group relative flex items-center gap-3 rounded-lg pl-4 pr-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors">
                    <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-primary animate-pulse" />
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="bg-secondary text-secondary-foreground text-[10px] font-bold">RA</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Research Agent</p>
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="size-3 text-primary animate-spin" />
                        <p className="truncate text-[11px] text-primary font-medium">Thinking...</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Gemini</span>
                      </div>
                    </div>
                  </div>

                  {/* Idle 2 */}
                  <div className="group relative flex items-center gap-3 rounded-lg pl-4 pr-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors">
                    <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-transparent" />
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="bg-secondary text-secondary-foreground text-[10px] font-bold">WC</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">Writing Coach</p>
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] text-muted-foreground">Creative writing</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Opus</span>
                      </div>
                    </div>
                    <Settings2 className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>

                  {/* Unavailable */}
                  <div className="group relative flex items-center gap-3 rounded-lg pl-4 pr-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors opacity-50">
                    <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-transparent" />
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="bg-secondary text-secondary-foreground text-[10px] font-bold">DO</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">DevOps Bot</p>
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle className="size-3 text-warning" />
                        <p className="truncate text-[11px] text-warning">Model unavailable</p>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">· Opus</span>
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Typing Indicator">
                <div className="max-w-2xl surface-chat rounded-xl p-6 border">
                  <div className="flex gap-2.5">
                    <Avatar className="size-8 shrink-0"><AvatarFallback className="gradient-primary text-white text-xs"><Bot className="size-4" /></AvatarFallback></Avatar>
                    <div className="space-y-1">
                      <span className="text-xs font-medium">Financial Advisor</span>
                      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-bubble-agent px-4 py-3">
                        <span className="size-2 rounded-full bg-primary/60 animate-typing-dot" />
                        <span className="size-2 rounded-full bg-primary/60 animate-typing-dot delay-2" />
                        <span className="size-2 rounded-full bg-primary/60 animate-typing-dot delay-4" />
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Task Items — Sidebar">
                <p className="text-sm text-muted-foreground mb-4">
                  Task items in the sidebar. Status conveyed by icon and text color only.
                </p>
                <div className="max-w-xs space-y-1 rounded-xl border bg-sidebar p-3">
                  {/* Pending */}
                  <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-xs hover:bg-muted/70 transition-colors">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px] bg-secondary">FA</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">Analyze monthly expenses</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Clock className="size-3 shrink-0 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground">Pending</span>
                      </div>
                    </div>
                  </div>
                  {/* In Progress */}
                  <div className="flex items-center gap-3 rounded-lg bg-primary/8 px-3 py-2.5 text-xs hover:bg-primary/15 transition-colors">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px] gradient-primary text-white">RA</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">Generate quarterly report</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Loader2 className="size-3 shrink-0 text-primary animate-spin" />
                        <span className="text-[10px] text-primary font-medium">Running</span>
                      </div>
                    </div>
                  </div>
                  {/* Completed */}
                  <div className="flex items-center gap-3 rounded-lg bg-success/8 px-3 py-2.5 text-xs hover:bg-success/15 transition-colors">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px] bg-secondary">AS</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">Summarize meeting notes</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <CheckCircle className="size-3 shrink-0 text-success" />
                        <span className="text-[10px] text-success font-medium">Done</span>
                      </div>
                    </div>
                  </div>
                  {/* Failed */}
                  <div className="flex items-center gap-3 rounded-lg bg-destructive/8 px-3 py-2.5 text-xs hover:bg-destructive/15 transition-colors">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px] bg-secondary">DO</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">Deploy to production</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <AlertCircle className="size-3 shrink-0 text-destructive" />
                        <span className="text-[10px] text-destructive font-medium">Failed</span>
                      </div>
                    </div>
                  </div>
                  {/* Cancelled */}
                  <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-xs opacity-60 hover:bg-muted/70 transition-colors">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px] bg-secondary">AS</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">Translate documentation</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <X className="size-3 shrink-0 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground">Cancelled</span>
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Task Results — Chat">
                <p className="text-sm text-muted-foreground mb-4">
                  Task results appear as centered cards. Status is conveyed by the icon and status text color.
                  Failed tasks tint the result block.
                </p>
                <div className="max-w-2xl surface-chat rounded-xl p-6 border space-y-4">
                  {/* Task completed (await) */}
                  <div className="flex justify-center px-4">
                    <div className="w-full max-w-md surface-card rounded-xl border border-border p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8 shrink-0">
                          <AvatarFallback className="text-[10px] gradient-primary text-white">FA</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">Analyze monthly expenses</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <CheckCircle className="size-3 text-success shrink-0" />
                            <span className="text-xs text-success font-medium">Task completed</span>
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">14:35</span>
                          </div>
                        </div>
                      </div>
                      <div className="rounded-lg bg-muted/80 p-3">
                        <p className="text-xs text-foreground leading-relaxed">Your top 3 expense categories: Subscriptions ($142), Dining ($98), Transport ($67). Total savings potential: $85/month by optimizing subscriptions.</p>
                      </div>
                    </div>
                  </div>

                  {/* Task failed */}
                  <div className="flex justify-center px-4">
                    <div className="w-full max-w-md surface-card rounded-xl border border-border p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8 shrink-0">
                          <AvatarFallback className="text-[10px] bg-secondary">DO</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">Deploy to production</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <AlertCircle className="size-3 text-destructive shrink-0" />
                            <span className="text-xs text-destructive font-medium">Task failed</span>
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">01:52</span>
                          </div>
                        </div>
                      </div>
                      <div className="rounded-lg bg-destructive/10 p-3">
                        <p className="text-xs text-destructive leading-relaxed">Error: No LLM provider available for model claude-sonnet-4-5-20250514</p>
                      </div>
                    </div>
                  </div>

                  {/* Task completed (async) — inline notification */}
                  <div className="flex justify-center px-4">
                    <div className="flex items-center gap-2 rounded-full bg-bubble-system px-4 py-1.5 text-bubble-system-foreground">
                      <Avatar className="size-4 shrink-0">
                        <AvatarFallback className="text-[7px] bg-secondary">AS</AvatarFallback>
                      </Avatar>
                      <CheckCircle className="size-3" />
                      <p className="text-xs">Task &quot;Translate docs&quot; completed</p>
                    </div>
                  </div>
                </div>
              </SubSection>
            </Section>

            {/* ─── TOOL CALLS ─────────────────────────────────── */}
            <Section id="tool-calls" title="Tool Calls">

              <SubSection title="Domain Badges & Icons">
                <p className="text-sm text-muted-foreground mb-3">
                  Each tool domain has a dedicated icon, color, and label — centralized in <code className="text-xs bg-muted px-1 rounded">TOOL_DOMAIN_META</code>.
                  Reusable via <code className="text-xs bg-muted px-1 rounded">{'<ToolDomainBadge>'}</code> and <code className="text-xs bg-muted px-1 rounded">{'<ToolDomainIcon>'}</code>.
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {(Object.keys(TOOL_DOMAIN_META) as BuiltinToolDomain[]).map((domain) => (
                    <ToolDomainBadge key={domain} domain={domain} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-4">
                  {(Object.keys(TOOL_DOMAIN_META) as BuiltinToolDomain[]).map((domain) => {
                    const meta = TOOL_DOMAIN_META[domain]
                    return (
                      <div key={domain} className="flex flex-col items-center gap-1.5">
                        <div className={cn('flex size-10 items-center justify-center rounded-lg', meta.bg)}>
                          <ToolDomainIcon domain={domain} className={cn('size-5', meta.text)} />
                        </div>
                        <span className="text-[10px] text-muted-foreground capitalize">{domain}</span>
                      </div>
                    )
                  })}
                </div>
              </SubSection>

              <SubSection title="Trigger Button (Header)">
                <div className="flex items-center gap-6">
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="ghost" size="icon-sm" className="relative"><Wrench className="size-4" /></Button>
                    <span className="text-[10px] text-muted-foreground">No calls</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="ghost" size="icon-sm" className="relative">
                      <Wrench className="size-4" />
                      <Badge variant="default" className="absolute -top-1 -right-1 size-4 p-0 text-[9px] flex items-center justify-center rounded-full">7</Badge>
                    </Button>
                    <span className="text-[10px] text-muted-foreground">With count</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="ghost" size="icon-sm" className="relative bg-muted">
                      <Wrench className="size-4" />
                      <Badge variant="default" className="absolute -top-1 -right-1 size-4 p-0 text-[9px] flex items-center justify-center rounded-full">12</Badge>
                    </Button>
                    <span className="text-[10px] text-muted-foreground">Panel open</span>
                  </div>
                </div>
              </SubSection>

              {/* ── PROPOSAL A ─────────────────────────────────── */}
              <SubSection title="Proposal A — Left border accent">
                <p className="text-sm text-muted-foreground mb-4">
                  Colored left border identifies the domain. Subtle, scannable. Background tints on expand. Tool calls appear inline within the Agent&apos;s message flow.
                </p>
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* In-conversation */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">In-Conversation</p>
                    <div className="max-w-lg surface-chat rounded-xl p-4 border space-y-3">
                      {/* User message */}
                      <div className="flex justify-end gap-2.5">
                        <div className="max-w-[75%] space-y-1">
                          <div className="flex items-center justify-end gap-2"><span className="text-xs text-muted-foreground">Nicolas</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          <div className="gradient-primary rounded-2xl rounded-br-md px-4 py-2.5 text-white shadow-sm"><p className="text-sm">What do you know about my work schedule?</p></div>
                        </div>
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="bg-secondary text-xs"><User className="size-4" /></AvatarFallback></Avatar>
                      </div>
                      {/* Agent reply with tool calls embedded in the flow */}
                      <div className="flex gap-2.5">
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="gradient-primary text-white text-xs"><Bot className="size-4" /></AvatarFallback></Avatar>
                        <div className="max-w-[85%] space-y-2">
                          <div className="flex items-center gap-2"><span className="text-xs font-medium">Assistant</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          {/* First text segment */}
                          <div className="rounded-2xl rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">Let me check your memories and search for updates...</p></div>
                          {/* Tool calls triggered mid-stream */}
                          <div className="space-y-1">
                            {(['memory', 'search'] as BuiltinToolDomain[]).map((domain) => {
                              const meta = TOOL_DOMAIN_META[domain]
                              const names: Record<string, string> = { memory: 'Recall Memory', search: 'Web Search' }
                              return (
                                <div key={domain} className={cn('rounded-lg border-l-2', meta.border)}>
                                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                                    <ToolDomainIcon domain={domain} className={cn('size-3.5', meta.text)} />
                                    <span className="flex-1 truncate text-xs font-medium text-muted-foreground">{names[domain]}</span>
                                    <CheckCircle className="size-3 text-success" />
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                          {/* Continuation after tool results */}
                          <div className="rounded-2xl rounded-tl-md rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">Based on your memories, you work Mon–Fri 9–5. I also found a recent schedule update confirming next week&apos;s shift change.</p></div>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Side panel */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Side Panel</p>
                    <div className="max-w-sm rounded-xl border bg-background/80 backdrop-blur-sm overflow-hidden">
                      <div className="flex items-center justify-between border-b px-3 py-2.5">
                        <div><h3 className="text-sm font-semibold">Tool Calls</h3><p className="text-[10px] text-muted-foreground">3 tool call(s)</p></div>
                        <Button variant="ghost" size="icon-xs"><X className="size-3.5" /></Button>
                      </div>
                      <div className="p-2 space-y-1">
                        {(['memory', 'search', 'vault'] as BuiltinToolDomain[]).map((domain, i) => {
                          const meta = TOOL_DOMAIN_META[domain]
                          const names: Record<string, string> = { memory: 'Recall Memory', search: 'Web Search', vault: 'Get Secret' }
                          const isOpen = i === 0
                          return (
                            <div key={domain} className={cn('rounded-lg border-l-2', meta.border, isOpen && meta.bg)}>
                              <div className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-muted/50 transition-colors">
                                <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                                <ToolDomainIcon domain={domain} className={cn('size-4', meta.text)} />
                                <span className="flex-1 truncate text-sm font-medium">{names[domain]}</span>
                                <CheckCircle className="size-3.5 text-success" />
                                <span className="text-[10px] text-muted-foreground tabular-nums">14:32</span>
                              </div>
                              {isOpen && (
                                <div className="px-3 pb-2 space-y-2">
                                  <ToolDomainBadge domain={domain} />
                                  <div className="rounded-md bg-muted/30 p-2">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-1">Input</p>
                                    <pre className="text-xs text-foreground/80">{'{ "query": "work schedule" }'}</pre>
                                  </div>
                                  <div className="rounded-md bg-muted/30 p-2">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-1">Output</p>
                                    <pre className="text-xs text-foreground/80">{'{ "results": [{ "id": "m1" }] }'}</pre>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              {/* ── PROPOSAL B ─────────────────────────────────── */}
              <SubSection title="Proposal B — Full color card">
                <p className="text-sm text-muted-foreground mb-4">
                  Entire card uses domain background. Strong visual separation between domains. Tool calls appear within the Agent&apos;s streaming response.
                </p>
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* In-conversation */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">In-Conversation</p>
                    <div className="max-w-lg surface-chat rounded-xl p-4 border space-y-3">
                      <div className="flex justify-end gap-2.5">
                        <div className="max-w-[75%] space-y-1">
                          <div className="flex items-center justify-end gap-2"><span className="text-xs text-muted-foreground">Nicolas</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          <div className="gradient-primary rounded-2xl rounded-br-md px-4 py-2.5 text-white shadow-sm"><p className="text-sm">Memorize that I prefer dark mode and generate me an avatar.</p></div>
                        </div>
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="bg-secondary text-xs"><User className="size-4" /></AvatarFallback></Avatar>
                      </div>
                      {/* Agent reply with tool calls embedded */}
                      <div className="flex gap-2.5">
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="gradient-primary text-white text-xs"><Bot className="size-4" /></AvatarFallback></Avatar>
                        <div className="max-w-[85%] space-y-2">
                          <div className="flex items-center gap-2"><span className="text-xs font-medium">Assistant</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          <div className="rounded-2xl rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">Sure! Let me save your preference and create an avatar for you.</p></div>
                          {/* Tool calls mid-stream */}
                          <div className="space-y-1.5">
                            {(['memory', 'images'] as BuiltinToolDomain[]).map((domain) => {
                              const meta = TOOL_DOMAIN_META[domain]
                              const names: Record<string, string> = { memory: 'Memorize', images: 'Generate Image' }
                              const statuses: Record<string, string> = { memory: 'success', images: 'pending' }
                              return (
                                <div key={domain} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-1.5', meta.bg, meta.border)}>
                                  <div className={cn('flex size-5 items-center justify-center rounded', meta.bg)}>
                                    <ToolDomainIcon domain={domain} className={cn('size-3', meta.text)} />
                                  </div>
                                  <span className="flex-1 truncate text-xs font-medium text-muted-foreground">{names[domain]}</span>
                                  <ToolDomainBadge domain={domain} className="text-[9px]" showLabel={false} />
                                  {statuses[domain] === 'success'
                                    ? <CheckCircle className="size-3 text-success" />
                                    : <Loader2 className="size-3 text-muted-foreground animate-spin" />
                                  }
                                </div>
                              )
                            })}
                          </div>
                          {/* Continuation */}
                          <div className="rounded-2xl rounded-tl-md rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">Your dark mode preference is saved! The avatar is still being generated, I&apos;ll let you know when it&apos;s ready.</p></div>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Side panel */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Side Panel</p>
                    <div className="max-w-sm rounded-xl border bg-background/80 backdrop-blur-sm overflow-hidden">
                      <div className="flex items-center justify-between border-b px-3 py-2.5">
                        <div><h3 className="text-sm font-semibold">Tool Calls</h3><p className="text-[10px] text-muted-foreground">3 tool call(s)</p></div>
                        <Button variant="ghost" size="icon-xs"><X className="size-3.5" /></Button>
                      </div>
                      <div className="p-2 space-y-1.5">
                        {(['search', 'memory', 'images'] as BuiltinToolDomain[]).map((domain, i) => {
                          const meta = TOOL_DOMAIN_META[domain]
                          const names: Record<string, string> = { search: 'Web Search', memory: 'Memorize', images: 'Generate Image' }
                          const isOpen = i === 1
                          return (
                            <div key={domain} className={cn('rounded-lg border', meta.bg, meta.border)}>
                              <div className="flex items-center gap-2 px-3 py-2 cursor-pointer">
                                <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                                <div className={cn('flex size-6 items-center justify-center rounded-md', meta.bg, meta.border)}>
                                  <ToolDomainIcon domain={domain} className={cn('size-3.5', meta.text)} />
                                </div>
                                <span className="flex-1 truncate text-sm font-medium">{names[domain]}</span>
                                <ToolDomainBadge domain={domain} className="text-[9px]" />
                                <CheckCircle className="size-3.5 text-success" />
                              </div>
                              {isOpen && (
                                <div className="px-3 pb-2 space-y-2 border-t border-border/30 pt-2">
                                  <div className="rounded-md bg-background/60 p-2">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-1">Input</p>
                                    <pre className="text-xs text-foreground/80">{'{ "content": "prefers dark mode" }'}</pre>
                                  </div>
                                  <div className="rounded-md bg-background/60 p-2">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-1">Output</p>
                                    <pre className="text-xs text-foreground/80">{'{ "id": "mem_abc", "stored": true }'}</pre>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              {/* ── PROPOSAL C ─────────────────────────────────── */}
              <SubSection title="Proposal C — Compact flat list">
                <p className="text-sm text-muted-foreground mb-4">
                  Minimal flat rows grouped in a card. Icon in a colored square. Cleanest density. Tool calls grouped inline within the Agent&apos;s response.
                </p>
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* In-conversation */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">In-Conversation</p>
                    <div className="max-w-lg surface-chat rounded-xl p-4 border space-y-3">
                      <div className="flex justify-end gap-2.5">
                        <div className="max-w-[75%] space-y-1">
                          <div className="flex items-center justify-end gap-2"><span className="text-xs text-muted-foreground">Nicolas</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          <div className="gradient-primary rounded-2xl rounded-br-md px-4 py-2.5 text-white shadow-sm"><p className="text-sm">Check my vault for the API key, then run a shell command.</p></div>
                        </div>
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="bg-secondary text-xs"><User className="size-4" /></AvatarFallback></Avatar>
                      </div>
                      {/* Agent reply with tool calls embedded */}
                      <div className="flex gap-2.5">
                        <Avatar className="size-8 shrink-0"><AvatarFallback className="gradient-primary text-white text-xs"><Bot className="size-4" /></AvatarFallback></Avatar>
                        <div className="max-w-[85%] space-y-2">
                          <div className="flex items-center gap-2"><span className="text-xs font-medium">Assistant</span><span className="text-xs text-muted-foreground">14:32</span></div>
                          <div className="rounded-2xl rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">I&apos;ll retrieve the key and run the deploy command.</p></div>
                          {/* Tool calls grouped in a card */}
                          <div className="rounded-lg border bg-card overflow-hidden">
                            {(['vault', 'shell'] as BuiltinToolDomain[]).map((domain, i) => {
                              const meta = TOOL_DOMAIN_META[domain]
                              const names: Record<string, string> = { vault: 'Get Secret', shell: 'Run Shell Command' }
                              const isLast = i === 1
                              return (
                                <div key={domain} className={cn('flex items-center gap-2.5 px-2.5 py-2', !isLast && 'border-b border-border/50')}>
                                  <div className={cn('flex size-6 items-center justify-center rounded-md shrink-0', meta.bg)}>
                                    <ToolDomainIcon domain={domain} className={cn('size-3', meta.text)} />
                                  </div>
                                  <span className="flex-1 truncate text-xs font-medium text-muted-foreground">{names[domain]}</span>
                                  <CheckCircle className="size-3 text-success" />
                                </div>
                              )
                            })}
                          </div>
                          {/* Continuation */}
                          <div className="rounded-2xl rounded-tl-md rounded-bl-md bg-bubble-agent px-4 py-2.5 text-bubble-agent-foreground shadow-sm"><p className="text-sm">Done! Retrieved the key and ran the deploy command successfully. Everything looks good.</p></div>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Side panel */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Side Panel</p>
                    <div className="max-w-sm rounded-xl border bg-background/80 backdrop-blur-sm overflow-hidden">
                      <div className="flex items-center justify-between border-b px-3 py-2.5">
                        <div><h3 className="text-sm font-semibold">Tool Calls</h3><p className="text-[10px] text-muted-foreground">4 tool call(s)</p></div>
                        <Button variant="ghost" size="icon-xs"><X className="size-3.5" /></Button>
                      </div>
                      <div>
                        {(['vault', 'shell', 'inter-agent', 'images'] as BuiltinToolDomain[]).map((domain, i) => {
                          const meta = TOOL_DOMAIN_META[domain]
                          const names: Record<string, string> = { vault: 'Get Secret', shell: 'Run Shell Command', 'inter-agent': 'Send Message', images: 'Generate Image' }
                          const statuses = ['success', 'success', 'pending', 'error'] as const
                          const statusIcons = { success: CheckCircle, pending: Loader2, error: AlertCircle }
                          const statusClasses: Record<string, string> = { success: 'text-success', pending: 'text-muted-foreground animate-spin', error: 'text-destructive' }
                          const status = statuses[i] ?? 'success'
                          const StatusIcon = statusIcons[status]
                          const isOpen = i === 3
                          const isLast = i === 3
                          return (
                            <div key={domain}>
                              <div className={cn('flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors', !isLast && !isOpen && 'border-b border-border/50')}>
                                <div className={cn('flex size-7 items-center justify-center rounded-lg shrink-0', meta.bg)}>
                                  <ToolDomainIcon domain={domain} className={cn('size-3.5', meta.text)} />
                                </div>
                                <span className="flex-1 truncate text-sm font-medium">{names[domain]}</span>
                                <StatusIcon className={cn('size-3.5 shrink-0', statusClasses[status])} />
                                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">14:32</span>
                                <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                              </div>
                              {isOpen && (
                                <div className="px-3 pb-3 space-y-2 border-b border-border/50">
                                  <div className="flex items-center gap-2">
                                    <ToolDomainBadge domain={domain} />
                                    <span className="text-[10px] text-destructive font-medium">Error</span>
                                  </div>
                                  <div className="rounded-md bg-muted/30 p-2">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-1">Input</p>
                                    <pre className="text-xs text-foreground/80">{'{ "prompt": "A robot mascot" }'}</pre>
                                  </div>
                                  <div className="rounded-md bg-destructive/5 border border-destructive/20 p-2">
                                    <p className="text-[10px] font-medium text-destructive mb-1">Output</p>
                                    <pre className="text-xs text-destructive/80">{'{ "error": "Rate limit exceeded" }'}</pre>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

            </Section>

            {/* ─── LOADING & EMPTY STATES ─────────────────────── */}
            <Section id="loading-states" title="Loading & Empty States">
              <SubSection title="Loading Skeletons">
                <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
                  <div className="space-y-3 surface-chat rounded-xl p-6 border">
                    <div className="flex gap-2.5">
                      <Skeleton className="size-8 rounded-full shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-16 w-full rounded-2xl rounded-bl-md" />
                      </div>
                    </div>
                    <div className="flex gap-2.5 justify-end">
                      <div className="space-y-2 max-w-[75%]">
                        <Skeleton className="h-3 w-16 ml-auto" />
                        <Skeleton className="h-10 w-48 rounded-2xl rounded-br-md" />
                      </div>
                      <Skeleton className="size-8 rounded-full shrink-0" />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex overflow-hidden rounded-xl border bg-card">
                      <Skeleton className="w-20 shrink-0 h-20 rounded-none" />
                      <div className="flex flex-1 flex-col justify-center gap-2 p-3">
                        <Skeleton className="h-3.5 w-32" />
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-2 w-12" />
                      </div>
                    </div>
                    <div className="flex overflow-hidden rounded-xl border bg-card">
                      <Skeleton className="w-20 shrink-0 h-20 rounded-none" />
                      <div className="flex flex-1 flex-col justify-center gap-2 p-3">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-2 w-12" />
                      </div>
                    </div>
                  </div>
                </div>
              </SubSection>

              <SubSection title="Empty States">
                <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 p-8 text-center">
                    <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-3">
                      <Bot className="size-6 text-muted-foreground" />
                    </div>
                    <p className="font-medium">No Agents yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">Create your first AI assistant to get started.</p>
                    <Button size="sm" className="mt-4 gradient-primary border-0 text-white">
                      <Plus className="size-4" /> Create an Agent
                    </Button>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 p-8 text-center">
                    <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-3">
                      <Search className="size-6 text-muted-foreground" />
                    </div>
                    <p className="font-medium">No results</p>
                    <p className="mt-1 text-sm text-muted-foreground">Try adjusting your search or filters.</p>
                  </div>
                </div>
              </SubSection>
            </Section>

            {/* ─── SPACING ─────────────────────────────────────── */}
            <Section id="spacing" title="Spacing & Layout">
              <div className="grid gap-8 lg:grid-cols-3">
                <SubSection title="Scale">
                  <div className="space-y-2">
                    {[{ l: '4px', w: 'w-1' }, { l: '8px', w: 'w-2' }, { l: '12px', w: 'w-3' }, { l: '16px', w: 'w-4' },
                      { l: '24px', w: 'w-6' }, { l: '32px', w: 'w-8' }, { l: '48px', w: 'w-12' }, { l: '64px', w: 'w-16' },
                    ].map((i) => (
                      <div key={i.l} className="flex items-center gap-3">
                        <span className="w-10 text-right text-xs text-muted-foreground">{i.l}</span>
                        <div className={`h-4 rounded-sm gradient-primary ${i.w}`} />
                      </div>
                    ))}
                  </div>
                </SubSection>
                <SubSection title="Radius">
                  <div className="flex flex-wrap gap-3">
                    {[{ l: 'sm', c: 'rounded-sm' }, { l: 'md', c: 'rounded-md' }, { l: 'lg', c: 'rounded-lg' },
                      { l: 'xl', c: 'rounded-xl' }, { l: '2xl', c: 'rounded-2xl' }, { l: 'full', c: 'rounded-full' },
                    ].map((i) => (
                      <div key={i.l} className="flex flex-col items-center gap-1.5">
                        <div className={`size-14 border-2 border-primary/30 bg-primary/10 ${i.c}`} />
                        <span className="text-xs text-muted-foreground">{i.l}</span>
                      </div>
                    ))}
                  </div>
                </SubSection>
                <SubSection title="Shadows">
                  <div className="flex flex-wrap gap-4">
                    {[{ l: 'xs', c: 'shadow-xs' }, { l: 'sm', c: 'shadow-sm' }, { l: 'md', c: 'shadow-md' }, { l: 'lg', c: 'shadow-lg' }, { l: 'xl', c: 'shadow-xl' }].map((i) => (
                      <div key={i.l} className="flex flex-col items-center gap-1.5">
                        <div className={`size-14 rounded-xl surface-card border ${i.c}`} />
                        <span className="text-xs text-muted-foreground">{i.l}</span>
                      </div>
                    ))}
                  </div>
                </SubSection>
              </div>
            </Section>

            {/* ─── FOOTER ──────────────────────────────────────── */}
            <div className="border-t pt-8 text-center">
              <p className="text-sm text-muted-foreground">
                <span className="gradient-primary-text font-bold">Gezy</span> &mdash; {currentPalette?.name ?? 'Aurora'} Design System &middot; 32 components &middot; Dev only.
              </p>
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
