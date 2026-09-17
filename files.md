# Files — explorateur & éditeur de fichiers des workspaces

> Spec de la section **Files** : un explorateur/éditeur type VSCode permettant à l'utilisateur de consulter, éditer, organiser et partager les fichiers des workspaces d'agents directement depuis l'UI — sans passer par un agent, sans télécharger/ré-uploader.
>
> Origine du besoin : un agent produit un fichier (« je l'ai posé dans mon workspace ») et l'utilisateur veut le modifier lui-même, immédiatement, dans le navigateur.
>
> Cette spec a été vérifiée contre le codebase (passe adversariale multi-agents) : chaque symbole/fichier cité existe sauf mention « nouveau » ou « à exporter ».
>
> **Statut : SHIPPED** — toutes les phases P1–P9 (§ 11) sont implémentées, livrables périphériques compris.
>
> **Note historique** : cette spec cite comme modèle le pipeline des mentions de
> tickets (`remarkTicketMentions`, `TicketMentionContext`, `useTicketSearch`,
> le trigger `#` du composer) et la source de browse « projet ». La gestion de
> projet a depuis été retirée du produit : ces références décrivent l'état du
> codebase au moment de la conception, plus le code actuel.

---

## 1. Principes directeurs

1. **L'utilisateur touche le disque, pas l'agent.** Aucune opération de cette feature ne déclenche de tour LLM. C'est une UI directe sur `data/workspaces/<agentId>/`.
2. **Une seule implémentation, plusieurs portes d'entrée.** Une page routée `/files` unique ; la fiche agent, le chat et les liens profonds y mènent pré-scopés. Pas de second browser embarqué ailleurs.
3. **Nommage : la section s'appelle `Files`** (icône folder). « Workspace » reste le terme pour la racine par agent *à l'intérieur* de la page (sélecteur). Raisons : « workspace » est un concept interne agent (prompts, tools) ; « Files » est extensible si on unifie d'autres racines plus tard (file-storage) ; cohérent avec le registre de la nav (Tasks, Crons…).
4. **Ouvert à tous les utilisateurs authentifiés** (pas de gate admin — décision fondateur : le rôle admin ne servira à terme qu'à inviter des utilisateurs).
5. **Réutilisation maximale** : CodeMirror existant (extension de `code-editor.tsx`, thème `codemirror-theme.ts`), `createFileFromWorkspace` pour le partage (via un nouveau mode de `FileStorageFormDialog`), le pattern popover du composer pour la palette `@`, le pattern `remarkTicketMentions`/`TicketMentionContext` pour les chemins cliquables, `UnsavedChangesDialog`, `useDraftMessage`.
6. **Mobile first-class** (règle CLAUDE.md n°8) : tree en drawer (`Sheet side="left"`), onglets scrollables, nav ajoutée à `AppTopBar`, menus « ⋯ » toujours visibles sur tactile, utilisable à 360 px.
7. **Confinement strict** : l'API HTTP est plus stricte que les tools agents — un chemin ne peut pas sortir du workspace ciblé (ni par `..`, ni par chemin absolu, ni par symlink — feuille comprise ; limite résiduelle connue : les hardlinks, § 7.6).
8. **Pas de nouvelle table DB.** Tout l'état est sur disque (fichiers) ou côté client (onglets, presse-papier). Le partage réutilise la table `file_storage` existante.
9. **Snapshot, pas lien vivant** : « Partager » copie le fichier vers le file-storage (sémantique identique au tool `store_file`). L'UI le dit explicitement.
10. **Honnêteté sur la fraîcheur** : les mutations REST et les tools natifs écrivant dans le workspace émettent des events SSE ; les mutations via `run_shell` ne sont pas captées (v1) — compensé par re-fetch à l'expansion/focus et bouton refresh.

---

## 2. Décisions actées (fondateur)

| Sujet | Décision |
|---|---|
| Nom de section / icône / route | `Files` / folder (lucide `Folder`/`FolderOpen`) / `/files` |
| Éditeur | CodeMirror 6 (existant) — Monaco rejeté (poids ~5 Mo, thèmes incompatibles avec le système de palettes, mauvais sur mobile) |
| Onglets | Oui, légers : état client uniquement, indicateur dirty, garde-fou fermeture. Tous les onglets sont épinglés en v1 (les « preview tabs » VSCode passent en v2). Pas de split view ni réordonnancement |
| Scope | Page globale avec **sélecteur de workspace** + entrées contextuelles pré-scopées (fiche agent / header de conversation, chips chat) |
| Accès | Tous les utilisateurs authentifiés |
| Partager | Clic droit → file-storage (snapshot) → URL copiée au presse-papier |
| Référencer un fichier dans le chat | Palette `@` étendue (groupe « Files ») ; chemins relatifs cliquables dans les messages (plugin remark) |
| Inter-workspace | Copier/coller (Ctrl+C/V) via presse-papier applicatif ; drag & drop réservé à l'intra-workspace (pointeurs fins) et à l'upload OS |
| Prompt système | Modifié : les agents savent que l'utilisateur voit/édite leur workspace et que les chemins relatifs deviennent des liens |
| Code d'erreur agent introuvable | `KIN_NOT_FOUND` (convention existante — 41 occurrences ; le renommage `AGENT_NOT_FOUND` se fera globalement avec la phase C du rebrand, pas ici) |
| Livrables périphériques | docs-site + `api.md` + site marketing + README mis à jour dans le même chantier |

---

## 3. UX — la page Files

### 3.1 Layout

Desktop (≥ `md`) :

```
┌──────────────────────────────────────────────────────────────┐
│ PageHeader  [icône Folder] Files          [actions: 🔍 ⟳]    │
├───────────────┬──────────────────────────────────────────────┤
│ [Workspace ▾] │ [tab: rapport.md ●] [tab: notes.txt] [×]     │
│ ┌───────────┐ ├──────────────────────────────────────────────┤
│ │ ▸ docs/   │ │                                              │
│ │ ▾ src/    │ │            CodeMirror / viewer               │
│ │   main.ts │ │                                              │
│ │ README.md │ │                                              │
│ └───────────┘ │                                              │
│ [+ file][+dir]│  barre de statut: chemin · taille · saved    │
└───────────────┴──────────────────────────────────────────────┘
```

- **Panneau gauche** (~`w-64`/`w-72`, non redimensionnable en v1 — `react-resizable-panels` n'est pas dans le repo, on n'ajoute pas de dépendance pour ça ; redimensionnement noté en v2) : sélecteur de workspace en haut, tree en dessous (`ScrollArea`), actions « nouveau fichier / nouveau dossier / upload » dans un en-tête de tree. Les noms longs sont tronqués (`truncate`) avec `title` = chemin relatif complet ; l'indentation est plafonnée en profondeur pour rester lisible à `w-64`.
- **Zone centrale** : rangée d'onglets + éditeur/viewer plein écran + barre de statut discrète (chemin complet, taille, état de sauvegarde).
- **`PageHeader`** canonique (règle n°9) : icône + titre + slot `actions` (bouton refresh + bouton loupe du quick-open).

Mobile (< `md`) :

- Le tree vit dans un **`Sheet side="left"`** ouvert par un bouton dans le slot `leading` du `PageHeader`. Sélectionner un fichier ferme le sheet.
- Onglets : rangée horizontale scrollable (`ScrollArea orientation="horizontal"`).
- Section ajoutée à `ActivityBar.ITEMS` **et** aux `modeItems` d'`AppTopBar` — **et `/files` ajouté aux deux listes de préfixes d'état actif** : `SECTION_PREFIXES` (`ActivityBar.tsx:32`) et le `sectionPrefixes` local d'`AppTopBar.tsx` (sinon « Agents » et « Files » sont actifs simultanément).
- Vérification à 360–400 px exigée avant merge (règle n°8).

### 3.2 Sélecteur de workspace & deep-links

- Dropdown (pattern de sélecteur d'agent existant, avatars inclus) listant tous les agents, l'agent actif en tête.
- Le workspace affiché est **toujours** `config.workspace.baseDir/<agentId>`. (Depuis, la page a été généralisée en sources multiples : agent / mini-app / dossier arbitraire, voir `workspace-sources.ts`.)
- Dernier workspace consulté mémorisé en `localStorage` (`files.lastAgentId`). Deep-link : `/files/:agentId?path=<relPath>` prime sur le localStorage.
- **Deep-link mort** (fichier supprimé entre temps — un chip d'un vieux message peut pointer vers un chemin disparu) : toast `files.notFound` + ouverture du workspace avec le tree déplié jusqu'au parent existant le plus profond. **Deep-link vers un dossier** : expansion + sélection dans le tree, pas d'onglet.
- Si le dossier workspace n'existe pas encore (agent n'a jamais écrit) : `EmptyState` « Ce workspace est vide » + actions « nouveau fichier » / « upload » (création disque lazy, comme dans les tools).

### 3.3 Tree

- **Chargement lazy par dossier** : `GET …/workspace/ls?path=` à l'expansion. Jamais d'arbre récursif complet (les workspaces peuvent contenir des `node_modules` de repos clonés).
- Tout est affiché, dotfiles compris. Aucun filtre d'ignore côté browser (contrairement à l'arbre ASCII du prompt) : l'utilisateur doit voir la réalité du disque. Les dossiers lourds ne coûtent rien tant qu'ils ne sont pas dépliés.
- Tri : dossiers d'abord, puis alphabétique (même ordre que `workspace-tree.ts`).
- **États de chargement/erreur (dès P2, pas du polish)** : rangées `Skeleton` pendant le `ls` d'un dossier ; échec → ligne d'erreur inline dans le nœud avec action « réessayer » (texte via `getErrorMessage`).
- Icônes : `Folder`/`FolderOpen` pour les dossiers ; pour les fichiers, nouvel utilitaire partagé `getFileIcon(name)` (map extension → icône lucide : `FileText`, `FileJson`, `FileCode`, `FileImage`, `FileArchive`, fallback `File`) dans `src/client/lib/file-icons.ts` — réutilisable ensuite par les chips chat et le file-storage.
- Sélection simple en v1 (multi-sélection = v2).
- État du tree (dossiers dépliés) conservé en mémoire par workspace pendant la session.

### 3.4 Onglets

- Ouverture d'un fichier → onglet (ou focus si déjà ouvert). **Tous les onglets sont épinglés** (le mode « preview tab » italique de VSCode est en v2 : son geste d'épinglage — double clic — n'a pas d'équivalent tactile).
- **Dirty** : point sur l'onglet dès modification non sauvegardée. Fermeture d'un onglet dirty → réutiliser le composant existant **`UnsavedChangesDialog`** (`components/common/UnsavedChangesDialog.tsx`, déjà branché sur les clés `common.unsavedChanges.*`).
- **Garde `beforeunload`** : enregistrée tant qu'au moins un onglet est dirty (confirm natif du navigateur) — le contenu non sauvegardé n'étant pas persisté, c'est la seule protection contre un Ctrl+W/F5 réflexe.
- Persistance : `sessionStorage` par agent (`files.tabs.<agentId>` : liste de chemins + onglet actif). Le contenu non sauvegardé n'est PAS persisté (assumé, simple).
- Changement de workspace : les onglets de l'ancien workspace sont conservés en mémoire et restaurés au retour.

### 3.5 Éditeur & viewers

Le type d'affichage est choisi par le serveur (`kind` dans la réponse de lecture) :

| `kind` | Critère serveur | Rendu client |
|---|---|---|
| `text` | non binaire (heuristique null-byte `isBinary`, § 7.7) et `size ≤ workspaceFiles.maxEditableSizeMb` | CodeMirror éditable |
| `image` | MIME `image/*` | `<img>` via l'endpoint raw (`?inline=1`), zoom léger |
| `pdf` | MIME `application/pdf` | `<iframe>`/`<object>` via l'endpoint raw |
| `binary` | null-byte détecté ou MIME opaque | Panneau métadonnées (nom, taille, MIME, modifié le) + bouton télécharger |
| `too-large` | texte mais au-delà de la limite | Métadonnées + télécharger + message explicite |

- **Éditeur** : on **étend `code-editor.tsx`** (règle n°7 — il accepte déjà `language?: CodeEditorLanguage | string` avec fallback plain, l'extension ne casse rien) avec trois props optionnelles : `filename?: string` (résolution du langage par extension via `@codemirror/language-data` — pattern exact de `markdown-editor.tsx`), `extensions?: Extension[]`, `onSave?: () => void` (keybinding Mod-S). Le nouveau `WorkspaceEditor` (`src/client/components/files/`) n'est que la **couche de composition** : choix du viewer selon `kind`, barre de statut, bannières conflit/suppression — il rend le `CodeEditor` étendu, il ne ré-emballe pas `@uiw/react-codemirror`.
- **Markdown** : toggle Édition / Aperçu (ou côte-à-côte ≥ `lg`). L'aperçu réutilise `MarkdownContent` via une **nouvelle prop** (ex. `disableChatPlugins`) — ses plugins sont aujourd'hui une constante module (`defaultRemarkPlugins`), la prop est un vrai changement à lister.
- **HTML** (`.html` / `.htm`) : même toggle Édition / Aperçu que le markdown. Le fichier reste `kind: 'text'` (donc éditable avec coloration) ; l'aperçu est une `<iframe srcDoc={draft}>` en **sandbox `allow-scripts allow-popups` sans `allow-same-origin`** — le JS du document (libs CDN type Chart.js) s'exécute mais dans une origine opaque : aucun accès aux cookies/session/`localStorage` de l'app. `srcDoc` rend l'aperçu live (reflète les éditions non sauvegardées). Limite assumée : les ressources **locales relatives** (image/CSS voisine sur disque) ne se chargent pas en `srcDoc` ; l'inline et les URLs absolues/CDN fonctionnent.
- **Export PDF** (HTML uniquement) : bouton « Exporter en PDF » dans la barre d'outils → `GET …/export-pdf?path=` (§ 6). Le serveur rend le fichier via Playwright en `file://` (les ressources voisines sur disque se résolvent, contrairement à l'aperçu `srcDoc`) et renvoie le PDF en `attachment` (téléchargement direct). Si l'onglet est dirty, le client sauvegarde d'abord (le rendu lit le disque). **Dépend du navigateur headless** (`WEB_BROWSING_HEADLESS_ENABLED` + Chromium, même prérequis que le browsing) : indisponible → erreur claire en toast, l'aperçu HTML reste fonctionnel.
- **Sauvegarde** : bouton + `Ctrl/Cmd+S`. Concurrence optimiste : le client renvoie le `modifiedAt` lu ; si le mtime disque a changé → `409 CONFLICT` → bannière « Le fichier a changé sur le disque » avec [Recharger] / [Écraser]. C'est le garde-fou essentiel : **l'agent peut écrire le même fichier pendant que l'utilisateur l'édite**.
- **Fichier supprimé du disque pendant l'édition** (par un agent) : si l'onglet est dirty, il **reste ouvert** avec une bannière « Supprimé du disque » (même composant que la bannière 409) ; `Ctrl+S` recrée le fichier (PUT sans `baseModifiedAt`). Onglet propre → fermeture automatique.
- Auto-save : non (v1). Sauvegarde explicite uniquement — cohérent avec le conflit géré ci-dessus.
- La page est **lazy-loadée** (comme toutes les sections) ; CodeMirror reste donc hors du bundle initial du chat.

### 3.6 Quick open (Ctrl/Cmd+P)

- `CommandDialog` (cmdk, déjà dans `components/ui/command.tsx`) : recherche de fichier par nom/chemin dans le workspace courant via `GET …/workspace/search`.
- Mêmes résultats que le groupe « Files » de la palette `@` du chat (même endpoint).
- Entrées : bouton loupe dans `PageHeader.actions` + raccourci clavier (avec `preventDefault()` — sinon dialogue d'impression).

### 3.7 Raccourcis clavier (desktop)

| Raccourci | Action |
|---|---|
| `Ctrl/Cmd+S` | Sauvegarder l'onglet actif (scope page, `preventDefault`) |
| `Ctrl/Cmd+P` | Quick open (scope page, `preventDefault`) |
| `F2` | Renommer la sélection du tree (édition inline) |
| `Delete` | Supprimer la sélection (avec `AlertDialog`) |
| `Ctrl/Cmd+C` / `X` / `V` | Copier / couper / coller (presse-papier applicatif, § 4.3) |
| `Alt+W` / clic molette sur l'onglet | Fermer l'onglet actif |

**Scoping obligatoire** : `F2`, `Delete`, `Ctrl+C/X/V` ne s'appliquent que **quand le tree a le focus** (roving tabindex sur les rangées) — jamais quand un input ou CodeMirror a le focus (ils casseraient le copier/coller de texte). Seul `Ctrl+S` traverse le focus éditeur (via la prop `onSave` du CodeEditor). **`Ctrl/Cmd+W` est interdit** : raccourci réservé navigateur, non interceptable — il fermerait l'app (d'où la garde `beforeunload` du § 3.4).

Les raccourcis sont enregistrés dans le **`KeyboardShortcutsDialog`** existant (dialog « ? ») sous un nouveau groupe `files` — c'est la convention de découvrabilité des raccourcis de l'app.

---

## 4. Opérations sur les fichiers

### 4.1 Menu contextuel (et règle de découvrabilité)

Clic droit (`ContextMenu` existant) sur un nœud du tree. **Chaque action existe aussi dans un point d'entrée visible** (règle n°11) : bouton « ⋯ » (`DropdownMenu`) sur la rangée — révélé au hover sur pointeurs fins, **toujours visible en dessous de `md`** (`opacity-100 md:opacity-0 md:group-hover:opacity-100`) car le tactile n'a ni hover ni clic droit (le long-press de Radix ContextMenu est un bonus, pas le point d'entrée).

Fichier : Ouvrir · Renommer (F2) · Dupliquer (= `copy` même dossier, suffixe auto) · Copier / Couper · Télécharger · **Partager…** · **Insérer dans le chat** · Copier le chemin relatif · Supprimer (destructif, `AlertDialog`).
Dossier : Nouveau fichier · Nouveau dossier · Upload ici · Renommer · Copier / Couper · Coller (si presse-papier non vide) · Copier le chemin · Supprimer (récursif — l'`AlertDialog` affiche le nombre d'éléments).
Racine (en-tête du tree) : Nouveau fichier · Nouveau dossier · Upload · Coller · Rafraîchir.

**Création de fichier/dossier** : ligne d'édition **inline dans le tree** (comme le renommage F2), pas de dialog. Validation du nom au blur/Enter (§ 7.5). La création de fichier passe par `PUT …/workspace/file` avec `createOnly: true` → **`409 DEST_EXISTS` si le nom existe déjà** (jamais d'écrasement silencieux ; l'UI repasse la ligne en édition).

### 4.2 Drag & drop

Deux usages distincts, deux mécanismes :

1. **Upload depuis l'OS** : dropzone native (HTML5 `dragover`/`drop`, pas dnd-kit) sur le tree entier ; le dossier survolé se surligne et devient la destination (racine par défaut). Multi-fichiers OK. Upload immédiat avec indicateur de progression par fichier (statuts `uploading`/`done`/`error`, pattern `useFileUpload`).
2. **Déplacement intra-workspace** : `@dnd-kit/core` (sensors `PointerSensor` distance 5) : glisser un fichier/dossier sur un dossier = `move`. Mise à jour optimiste du tree, rollback si l'API échoue. **Activé uniquement sur pointeurs fins** (`matchMedia('(pointer: fine)')`) : sur tactile, rendre chaque rangée draggable détournerait le scroll vertical du tree (fatal dans le `Sheet` mobile) — le déplacement tactile passe par couper/coller (§ 4.3). Pas de `TouchSensor` en v1. Pas de drag inter-workspace (un seul tree affiché — le presse-papier couvre ce cas).

### 4.3 Presse-papier applicatif (copier/coller, y compris inter-workspace)

- État client global (module/context) : `{ agentId, path, isDirectory, op: 'copy' | 'cut' }`.
- « Coller » dans n'importe quel dossier de n'importe quel workspace → `POST …/workspace/copy` (ou `move` si `cut`) avec `fromAgentId` ≠ agentId cible le cas échéant. Le serveur fait la copie disque-à-disque (jamais de transit par le client).
- Collision de nom : suffixe automatique ` (copy)` / ` (copy 2)` pour `copy` ; erreur `DEST_EXISTS` pour `move` (l'UI propose de renommer).
- Le presse-papier OS n'est pas utilisé pour les fichiers (impossible de transporter un fichier serveur dedans) ; « Copier le chemin » utilise, lui, le vrai presse-papier.

### 4.4 Partager (→ file-storage)

- « Partager… » ouvre `FileStorageFormDialog` — qui **doit d'abord gagner un mode** (règle n°7, le composant actuel exige un `File` navigateur et code en dur son POST multipart) : nouvelle prop `workspaceSource?: { agentId: string; path: string }` qui (a) masque l'input fichier et le sélecteur d'agent, (b) pré-remplit le nom avec le basename, (c) soumet vers `POST /api/file-storage/from-workspace` (§ 6.9), (d) affiche la ligne snapshot ci-dessous, (e) appelle `onSaved(file)` **avec le fichier créé en payload** (aujourd'hui `onSaved()` est vide) pour que l'appelant copie l'URL. Les options existantes (public, mot de passe, expiration **en minutes**, read-and-burn) sont réutilisées telles quelles. Pas de composant `ShareFileDialog` séparé : c'est ce câblage de prop.
- Succès → URL `{publicUrl}/s/{token}` copiée au presse-papier + toast.
- Le dialog affiche : *« Crée une copie figée — les modifications ultérieures du fichier du workspace ne seront pas reflétées. »*
- Le fichier partagé apparaît ensuite normalement dans Settings → File storage (gestion/révocation existantes).

### 4.5 Entrées contextuelles (fiche agent / conversation)

- **Header de conversation** (`ConversationHeader`) : item « Parcourir les fichiers » dans son menu → `/files/<agentId>`.
- **Carte agent** (`AgentCard`) : même action dans son menu contextuel/« ⋯ » existant.
- Livrées en **P2** avec la page (pas du polish — c'est la porte d'entrée principale demandée).

---

## 5. Intégrations chat

### 5.1 Palette `@` : groupe « Files » (composer → fichier)

Le composer (`MessageInput.tsx`) a déjà deux triggers (`@` users+agents, `/` commandes). On étend `@` — avec trois changements précis dans `MessageInput` (vérifiés nécessaires, ils ne sont pas optionnels) :

1. **`detectMention`** : la classe de caractères du walk arrière (`[a-zA-Z0-9_-]`) doit accepter `.` et `/`, sinon taper `@rapports/` ou `@analyse.md` ferme la popover (le walk bute sur le caractère et ne trouve plus le `@`). Attention à ce que les mentions `@user` simples terminent toujours correctement.
2. **`isMentionOpen`** : la gate actuelle n'ouvre la popover que si users/agents matchent — elle doit aussi s'ouvrir sur des hits fichiers seuls (et la garde de nav clavier associée).
3. **`handleMentionSelect`** : la branche fichier remplace **tout le token `@query` y compris le `@`** par l'insertion (les branches user/agent gardent leur `@`).

- `MentionPopover` passe d'une liste plate à des **groupes avec en-têtes** (Users / Agents / Files, fichiers cap à 8, icône `getFileIcon`, métadonnée taille) ; `getMentionItemCount`/`getMentionItemAt` aplatissent les groupes pour la nav clavier.
- Source : nouveau hook `useWorkspaceFileSearch` calqué sur `useTicketSearch` (debounce 150 ms, séquencement anti out-of-order) → `GET /api/agents/:agentId/workspace/search?q=…`, scoped sur **l'agent de la conversation courante**.
- **Insertion : le chemin relatif entre backticks** (ex. `` `rapports/analyse finale.md` `` + espace). Les backticks délimitent sans ambiguïté les chemins contenant espaces/accents — fréquents en français — à la fois pour l'agent qui lit et pour le visiteur `inlineCode` du § 5.2. Pas d'autre protocole : l'agent lit ce chemin avec ses tools filesystem existants.

### 5.2 Chemins cliquables dans les messages (message → browser)

Calqué sur le pipeline `remarkTicketMentions` → `TicketMention` → `TicketMentionContext` :

- **Plugin `remarkWorkspacePaths`** (`src/client/lib/remark-workspace-paths.ts`) :
  - *Nœuds `text`* : `findAndReplace` avec une regex **conservatrice** de candidats chemin (token contenant un `/` interne ou se terminant par une extension), **instanciée avec le flag `g`** (find-and-replace s'arrête au premier match sinon — le précédent `TICKET_MENTION_REGEX` est global et ré-instancié) et **avec `ignore: ['link']`** (remark-gfm autolinke les URLs nues ; sans ça, `https://example.com/a/b.md` se ferait découper). Bornes par lookbehind/lookahead sur le modèle de `TICKET_MENTION_REGEX`. Produit un nœud `hName: 'workspace-path'`, `hProperties: { 'data-path': raw }`.
  - *Nœuds `inlineCode`* : `findAndReplace` **ne visite que les nœuds `text`** — les `inlineCode` sont un autre type de literal, jamais traités (c'est le mécanisme réel ; le commentaire de `remark-ticket-mentions.ts` qui parle d'un « ignore par défaut » est inexact, ne pas le propager). Or les agents écrivent les chemins entre backticks, et la palette § 5.1 insère entre backticks. Le plugin fait donc **aussi** un visiteur sur les nœuds `inlineCode` dont la valeur entière est un candidat chemin — **volontairement permissif** (espaces et Unicode acceptés dès qu'il y a un `/` ou une extension) puisque l'existence est vérifiée serveur et que l'échec se dégrade en texte. Nœud custom identique, avec `data-was-code` pour conserver le style mono.
  - **Gate `isPlainText`** : `MarkdownContent` court-circuite ReactMarkdown (donc tous les plugins remark) pour les messages sans marqueur markdown — et ni `/` ni `.` n'est un marqueur. Un message nu « voilà rapports/analyse.md » ne deviendrait jamais une chip. La gate doit être étendue pour laisser passer les messages contenant un candidat chemin (réutiliser la regex), comme elle l'a déjà été pour `#`.
- **Composant `WorkspacePathMention`** (`components/chat/`) enregistré dans `markdownComponents['workspace-path']` :
  - Résolution **vérifiée côté serveur** via un provider batché **`WorkspacePathContext`** placé dans **`src/client/contexts/`** (comme son modèle `TicketMentionContext` — seul le composant chip vit dans `components/chat/`) : POST batché ≤ 50 chemins, debounce 50 ms, cache par `(agentId, path)` → `POST /api/agents/:agentId/workspace/resolve-paths`.
  - Existe → chip cliquable (icône fichier + chemin, style proche des chips `MessageFiles`) → `navigate('/files/' + agentId + '?path=' + encodeURIComponent(path))`.
  - N'existe pas / en attente → rendu du texte original tel quel (aucune fausse affordance, règle n°10). **Le faux positif de la regex est donc inoffensif.**
- **Portée du provider** : posé dans `ChatPanel` **et** `QuickChatPanel` (tous deux connaissent leur agent). Les autres rendus de `MarkdownContent` (TaskResultCard, crons…) restent sans provider en v1 : les chemins y restent du texte simple — dégradation propre, actée.
- Invalidation du cache : sur `workspace:changed` (matching **par préfixe** quand `isDirectory`, § 8.2) **et** purge via `useSSEResync` (sans ça, un téléphone déverrouillé garde des chips mortes indéfiniment — piège CATCHUP_GAP).

### 5.3 Browser → conversation

- Action « Insérer dans le chat » (menu contextuel) : **append du chemin (entre backticks) au draft localStorage de l'agent** — le mécanisme existe déjà : `useDraftMessage` persiste le draft par agent (`hivekeep:draft:<agentId>`) et le recharge au montage de `MessageInput`. On exporte un petit helper d'append, puis on navigue vers la conversation : le composer le ramasse naturellement, sans course de montage ni nouveau store. (Un event direct ne sert que si le composer est déjà monté — inutile en v1.)
- « Copier le chemin relatif » couvre le cas multi-fenêtres.

### 5.4 Prompt système (décision : oui, on le modifie)

Le bloc `## Workspace` de `prompt-builder.ts` (~l. 1610, qui contient déjà chemin + arbre ASCII) gagne ces lignes :

```markdown
The user can browse and edit your workspace at any time through the Files screen
of the app — files you create are directly visible, editable and shareable by them.
When you mention one of your workspace files in a message, write its relative path
in backticks (e.g. `reports/analysis.md`): it becomes a clickable link that opens
the file for the user. Don't paste full file contents into the chat when pointing
at the file is enough.
```

Effets attendus : les agents arrêtent de coller le contenu entier en chat, annoncent leurs livrables par chemin (→ chips cliquables), et savent que l'utilisateur peut éditer un fichier entre deux tours (moins de surprise sur les mtimes).

**Pas de nouveau tool agent en v1** : `store_file` (partage), les tools filesystem (lecture/écriture) et cette convention de chemins couvrent le besoin. Un éventuel tool `notify_file` est noté en v2.

---

## 6. API REST

Toutes les routes sous `/api/agents/:agentId/workspace` (montées dans `app.ts` via `app.route` — le pattern `:agentId` dans le chemin de montage est déjà pratiqué, cf. knowledge/quick-sessions ; auth middleware global `/api/*` déjà appliqué). `:agentId` accepte id ou slug (`resolveAgentByIdOrSlug`, synchrone) ; agent introuvable → `404 KIN_NOT_FOUND` (convention existante). Tous les `path` sont **relatifs à la racine du workspace** et validés (§ 7). Service : `src/server/services/workspace-files.ts` ; routes : `src/server/routes/workspace-files.ts`.

### 6.1 `GET /api/agents/:agentId/workspace/ls`

```typescript
// Query: ?path=docs/reports        (défaut: racine "")
// Response 200
{
  path: string,
  entries: Array<{
    name: string,
    path: string,              // relatif racine
    type: 'file' | 'dir',
    size: number,              // 0 pour les dirs
    modifiedAt: number,        // Unix ms
    isSymlink: boolean
  }>
}
// workspace inexistant → 200 { path: "", entries: [] } (création lazy)

// Error 404
{ error: { code: 'FILE_NOT_FOUND', message: '...' } }    // path inexistant
// Error 400
{ error: { code: 'PATH_FORBIDDEN', message: '...' } }    // traversal / hors workspace
```

> Tri serveur : dirs d'abord, alphabétique. Pas de filtre d'ignore (tout est listé). Les entrées utilisent `lstat`/`withFileTypes` (un symlink est listé comme tel, jamais suivi pour le typage). Le **contenu** d'un symlink n'est servi que s'il reste confiné (§ 7).

### 6.2 `GET /api/agents/:agentId/workspace/file`

```typescript
// Query: ?path=docs/report.md
// Response 200
{
  path: string,
  name: string,
  size: number,
  modifiedAt: number,          // ← à renvoyer dans PUT (concurrence optimiste)
  mimeType: string,            // via le helper mime partagé (§ 7.7)
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'too-large',
  content: string | null       // null sauf kind === 'text'
}

// Error 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN
// Error 400 { error: { code: 'IS_DIRECTORY', message: '...' } }
```

### 6.3 `GET /api/agents/:agentId/workspace/raw`

```typescript
// Query: ?path=images/chart.png&inline=1
// Response 200: stream binaire.
//   Content-Type: <mime>
//   X-Content-Type-Options: nosniff        (toujours — le MIME est deviné par extension)
//   Content-Disposition: attachment (défaut) | inline (si inline=1 ET MIME dans l'allowlist)
```

> **Allowlist inline exacte** : `image/*` **sauf `image/svg+xml` et tout `image/*+xml`** (un SVG inline exécute ses `<script>` dans l'origine authentifiée de l'app — stored XSS via un fichier d'agent ; il n'y a aucun CSP global), `application/pdf`, `text/plain`. Tout le reste — y compris SVG et `text/html` — est servi en `attachment`. Les réponses inline portent en plus `Content-Security-Policy: default-src 'none'; sandbox` en ceinture-bretelles. Précédent nosniff dans le repo : custom-tools / mini-apps.

### 6.4 `PUT /api/agents/:agentId/workspace/file`

```typescript
// Request
{
  path: string,
  content: string,             // texte uniquement
  baseModifiedAt?: number,     // mtime lu par le client ; absent = écrasement forcé
  createOnly?: boolean         // true = création stricte (« Nouveau fichier »)
}
// Response 200
{ path: string, size: number, modifiedAt: number }

// Error 409 — le fichier a changé depuis la lecture
{ error: { code: 'CONFLICT', message: '...' } }
// Error 409 — createOnly et le chemin existe déjà
{ error: { code: 'DEST_EXISTS', message: '...' } }
// Error 413 FILE_TOO_LARGE · 400 PATH_FORBIDDEN · 400 INVALID_NAME
```

> Crée le fichier (et les dossiers parents) si absent. Émet `workspace:changed`. Le client mémorise le `(path, modifiedAt)` de la réponse pour la réconciliation SSE (§ 8.2).

### 6.5 `POST mkdir` · `POST move` · `POST copy` · `DELETE file`

```typescript
// POST …/workspace/mkdir — Request: { path: string } → Response 200 { path }
//   Error 409 DEST_EXISTS · 400 INVALID_NAME

// POST …/workspace/move — Request: { from: string, to: string, fromAgentId?: string }
//   fromAgentId (id/slug) ≠ :agentId = déplacement inter-workspace (couper/coller).
//   `from` est validé contre la racine de fromAgentId ?? :agentId, `to` contre celle de :agentId
//   (deux racines distinctes pour l'inter-workspace — ne JAMAIS valider les deux contre la même).
//   Response 200 { from, to } · Error 409 DEST_EXISTS · 404 FILE_NOT_FOUND

// POST …/workspace/copy — même contrat que move ; collision résolue par suffixe " (copy N)"
//   Response 200 { from, to }   // to = chemin final, suffixé le cas échéant
//   Dossiers : copie récursive **streamée** avec abort dès dépassement du budget octets
//   OU entrées (§ 9) — jamais de pré-walk de mesure (qui serait lui-même le DoS).
//   Error 413 { error: { code: 'COPY_TOO_LARGE', message: '...' } }

// DELETE …/workspace/file — Query: ?path=… ; fichier OU dossier (récursif)
//   Response 200 { deleted: true, path }
```

> Tous émettent `workspace:changed` (sur les **deux** agents pour l'inter-workspace). Renommer = `move` même dossier.

### 6.6 `POST /api/agents/:agentId/workspace/upload`

```typescript
// Request: multipart/form-data
//   file: File          (répétable — multi-upload)
//   path: string        (dossier destination, défaut racine "")
// Response 201
{ files: Array<{ path: string, size: number, modifiedAt: number }> }
// Échec partiel (multi-fichiers) : les fichiers acceptés sont écrits, la réponse liste
// aussi { errors: Array<{ name: string, code: string }> } pour les refusés.

// Error 413 FILE_TOO_LARGE · 400 PATH_FORBIDDEN · 400 INVALID_NAME
```

> **Sanitisation du filename multipart** (il est contrôlé par le client et peut contenir `../`) : destination = `path + '/' + basename(filename)` ; tout séparateur ou caractère interdit dans le nom → `PATH_FORBIDDEN`/`INVALID_NAME`. **Collision : suffixe automatique ` (copy N)`** (cohérent avec § 4.3 — un upload ne doit jamais écraser silencieusement). Cap `workspaceFiles.maxUploadSizeMb` par fichier. Émet `workspace:changed` (type `created`). Pattern multipart : `routes/file-storage.ts`.

### 6.7 `GET /workspace/search`

```typescript
// GET /api/agents/:agentId/workspace/search?q=rapport&limit=20
// Response 200
{ hits: Array<{ path: string, name: string, size: number, modifiedAt: number }> }
```

> Walk serveur du workspace, match substring insensible à la casse sur le chemin relatif. **Le walk utilise `lstat`/`withFileTypes` et ne descend JAMAIS dans un répertoire symlinké** (évasion + cycles infinis sinon). Ignore les dossiers lourds : réutilise `IGNORED_DIRS` de `workspace-tree.ts` (**à exporter** — actuellement privé) ; contrairement au `ls`, une recherche qui traverse `node_modules` est inutilisable. Cap `limit` (défaut 20, max `searchMaxResults`) + budget de parcours `searchMaxEntries` (§ 9). Sert la palette `@` et le quick-open.

### 6.8 `POST /workspace/resolve-paths`

```typescript
// POST /api/agents/:agentId/workspace/resolve-paths
// Request: { paths: string[] }            // ≤ 50
// Response 200: { existing: string[] }    // sous-ensemble qui existe (fichiers seulement)
```

> Batché par `WorkspacePathContext` (§ 5.2). Chemins invalides (traversal) silencieusement absents de `existing` — pas d'erreur, ce sont des candidats de regex. Oracle d'existence assumé : utilisateurs authentifiés uniquement, et le `ls` expose déjà la même information.

### 6.9 `POST /api/file-storage/from-workspace` (partage)

```typescript
// Request
{
  agentId: string,             // id ou slug
  path: string,                // relatif workspace
  name?: string,               // défaut: basename
  description?: string,
  isPublic?: boolean,          // défaut true (le but est l'URL partageable)
  password?: string,
  expiresIn?: number,          // MINUTES — même unité que POST /api/file-storage,
                               // le tool store_file et FileStorageFormDialog
  readAndBurn?: boolean
}
// Response 201
{ file: { id, name, originalName, mimeType, size, url, isPublic, hasPassword, readAndBurn, expiresAt } }
// (même enveloppe { file } et même shape « résumé de création » que POST /api/file-storage —
//  PAS le serializer complet de la liste)
// Error 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN · 413 FILE_TOO_LARGE (limite file-storage)
```

> Wrapper REST du service existant `createFileFromWorkspace` (jusqu'ici accessible uniquement via le tool agent `store_file`) — **dont la validation de chemin est durcie au passage** en le faisant passer par le helper § 7 (son `startsWith` actuel ne fait pas de realpath). Route ajoutée dans `routes/file-storage.ts`.

---

## 7. Sécurité

Le confinement est la pierre angulaire — c'est une API d'écriture disque exposée en HTTP. **Trouvailles de la passe adversariale intégrées ci-dessous ; les tests § 7.8 sont bloquants pour P1.**

1. **Helper unique** `resolveWorkspaceFilePath(agentId, relPath)` (`workspace-files.ts`) :
   - rejette chemins absolus, composants `..`/`~`, **octets NUL et caractères de contrôle** (→ `PATH_FORBIDDEN` propre, pas un throw fs 500) — normalisation **avant** join ;
   - canonicalise le **chemin complet, feuille comprise** : si la cible existe, `lstat` final — un symlink-feuille est soit refusé pour l'écriture, soit `realpath` du chemin entier puis re-vérification pour la lecture. ⚠️ Canonicaliser seulement le parent est le bug classique : `ln -s /etc/passwd secret` passe un check parent-only (`workspace/secret` commence bien par la racine) puis `readFile` suit le lien ;
   - confinement : `resolved === workspaceRoot || resolved.startsWith(workspaceRoot + sep)` (sans le terme d'égalité, le `ls` de la racine elle-même serait rejeté) ;
   - `isPathBlocked` (blocklist existante) en ceinture-bretelles.
   - On **n'utilise pas** `resolveAndValidate` des tools : il autorise les chemins absolus hors workspace (droit des agents, pas de l'API HTTP).
2. **TOCTOU — le check pré-op ne suffit pas** : l'agent (qui a un shell) peut planter un symlink **entre** la validation et l'opération fs. Le contrôle doit s'appliquer **au moment de l'op** : ouvertures avec `O_NOFOLLOW` sur le composant final (lecture/écriture), refus de tout composant symlink sur les chemins d'écriture. À écrire noir sur blanc dans le service, pas seulement dans le pré-check.
3. **Pas d'exécution** : aucun endpoint n'exécute quoi que ce soit ; allowlist inline stricte + `nosniff` + CSP sandbox (§ 6.3).
4. **Auth** : middleware global existant ; tous les utilisateurs authentifiés (décision § 1.4). Les routes mutantes loggent `userId` + chemin (logStore existant) pour l'audit.
5. **Validation des noms saisis** (rename inline, création, filename d'upload) : non vide, pas de `/` ni `\` ni caractère de contrôle, ≠ `.`/`..`, ≤ 255 octets — appliquée client (feedback inline) **et** serveur (`400 INVALID_NAME`).
6. **Limite résiduelle connue — hardlinks** : `realpath` ne résout pas les hardlinks (autre nom du même inode, créable par un agent via shell sur le même filesystem). Risque accepté et documenté en v1 ; mitigation possible plus tard : monter `data/workspaces` sur un filesystem séparé (un hardlink ne traverse pas les FS). C'est pourquoi le § 1.7 ne promet plus un « JAMAIS » absolu.
7. **Helpers à extraire** (aujourd'hui privés/dupliqués — l'implémenteur ne peut pas les importer en l'état) : `isBinary` (privé dans `filesystem-tools.ts`) et `guessMimeType` (plusieurs copies privées dans le repo) → extraction vers un util serveur partagé, ex. `src/server/services/file-kind.ts`, plutôt qu'une sixième copie.
8. **Tests obligatoires** (`workspace-files.test.ts`, bloquants P1) : traversal (`../`, absolu, encodages `%2e%2e`, NUL), symlink-feuille et symlink-parent (lecture ET écriture), `ls` racine (cas d'égalité), conflit 409, `createOnly` 409, collision copy/upload, validation inter-workspace (from/to contre leurs racines respectives), noms invalides.

---

## 8. SSE

Checklist `sse.md` appliquée : type ajouté à `SSEEventType`, portée `sendToAgent`, payload documenté dans `api.md`, handlers client écrits, resync au réveil (y compris le cache de chips).

### 8.1 Nouvel event : `workspace:changed`

```typescript
{ event: 'workspace:changed', data: {
  agentId: string,
  changes: Array<{
    path: string,
    type: 'created' | 'modified' | 'deleted' | 'renamed',
    isDirectory: boolean,
    newPath?: string,         // pour renamed
    modifiedAt?: number       // mtime résultant — clé de réconciliation émetteur (§ 8.2)
  }>
} }
```

- **Portée : `sendToAgent(agentId, …)`** — règle de portée de `sse.md` : event lié à un Agent (le front filtre par `agentId` ; `sendToAgent` atteint déjà tous les appareils aujourd'hui, et l'event profitera du futur filtrage par agent). Pas `broadcast`.
- **Sémantique dossier** : une opération récursive (delete/move/copy/upload de dossier) émet **UN seul change** sur le chemin du dossier (`isDirectory: true`) — jamais une entrée par descendant (supprimer un dossier contenant un `node_modules` cloné = des milliers d'entrées sinon). `changes` est borné (≤ 20 par event ; au-delà, un seul change grossier sur le parent commun).
- **Émetteurs** :
  - toutes les routes mutantes du § 6 (write/mkdir/move/copy/delete/upload) — inter-workspace : un event par agent concerné ;
  - **tous les tools natifs qui écrivent dans le workspace statique** — la liste exhaustive vérifiée : `write_file`, `edit_file` (`filesystem-tools.ts`), `multi_edit` (`multi-edit-tools.ts` — c'est l'outil que la description de `write_file` recommande aux agents !), `download_stored_file` (`file-storage-tools.ts`, copie storage → workspace ; `store_file` lui ne mute pas le workspace), `download_email_attachment` (`email-tools.ts`). Implémentation : **un helper unique** `emitWorkspaceChangedForTool(ctx, absPath, type, opts)` exporté par `workspace-files.ts` (skip si le chemin sort du workspace statique ; calcul du chemin relatif), appelé par les 5 sites + les routes. Les tools importent déjà `sseManager` directement ailleurs (précédents : `mini-app-tools.ts`, `config-tools.ts`).
- **Gap assumé (v1)** : `run_shell` et les process enfants ne sont pas captés. Mitigations : re-fetch du dossier à l'expansion, bouton refresh, `useSSEResync`. v2 : `fs.watch` par workspace abonné, noté § 13.

### 8.2 Handlers client

- **Réconciliation de l'appareil émetteur** (piège MULTI_DEVICE — mécanisme explicite, pas un slogan) : le client mémorise le `(path, modifiedAt)` de sa dernière réponse `PUT`/upload et **ignore** un change `modified` qui matche exactement cette paire — sinon l'utilisateur qui retape juste après sa sauvegarde verrait la bannière conflit pour SA propre écriture. Tous les handlers tree sont **idempotents par chemin** (created = insert-if-absent trié, deleted = remove-if-present, renamed tolérant à une source déjà absente) : le double-apply de l'optimiste (dnd, upload) est alors inoffensif. Filtre `agentId` en tête de handler (checklist sse.md).
- **Matching par préfixe quand `isDirectory`** : tree (retrait/déplacement du sous-arbre), onglets (fermer ou re-préfixer tout chemin sous `path` → `newPath`), cache `WorkspacePathContext` (invalider toute clé commençant par `path + '/'`). Sans ça, supprimer `docs/` laisserait l'onglet `docs/a.md` ouvert et des chips mortes (règle n°10).
- Fichier ouvert reçu `modified` (non dirty, non émis par soi) → rechargement silencieux ; si dirty → bannière conflit (même UX que le 409). Fichier ouvert `deleted` → § 3.5 (bannière « Supprimé du disque » si dirty, fermeture sinon).
- **Merge, pas d'écrasement** (piège STATE_CLOBBER) ; dossier parent non chargé → ignorer (il se chargera à l'expansion).
- `useSSEResync` : re-fetch des dossiers actuellement dépliés + onglet actif **et purge du cache `WorkspacePathContext`** au réveil (piège CATCHUP_GAP — sans la purge, les chips de chat restent figées après un déverrouillage).

---

## 9. Configuration

Section `config.workspaceFiles` dans `config.ts` ; documentée dans `config.md` (env vars sans préfixe `HIVEKEEP_`, comme `WORKSPACE_BASE_DIR`/`UPLOAD_MAX_FILE_SIZE`) :

| Key | Env var | Default | Description |
|---|---|---|---|
| `workspaceFiles.maxEditableSizeMb` | `WORKSPACE_FILES_MAX_EDITABLE_SIZE` | `5` | Au-delà, un fichier texte est servi en `too-large` (téléchargement seulement) |
| `workspaceFiles.maxUploadSizeMb` | `WORKSPACE_FILES_MAX_UPLOAD_SIZE` | `100` | Taille max d'un fichier uploadé vers un workspace (0 = illimité ; plafonné par `MAX_REQUEST_BODY_MB`) |
| `workspaceFiles.maxCopySizeMb` | `WORKSPACE_FILES_MAX_COPY_SIZE` | `500` | Budget octets d'un `copy` récursif (abort en cours de copie, § 6.5) |
| `workspaceFiles.maxCopyEntries` | `WORKSPACE_FILES_COPY_MAX_ENTRIES` | `5000` | Budget entrées d'un `copy` récursif (des millions de petits fichiers contournent le cap octets) |
| `workspaceFiles.searchMaxResults` | `WORKSPACE_FILES_SEARCH_MAX_RESULTS` | `50` | Cap dur du paramètre `limit` de `/workspace/search` |
| `workspaceFiles.searchMaxEntries` | `WORKSPACE_FILES_SEARCH_MAX_ENTRIES` | `20000` | Budget de fichiers parcourus par requête de recherche (workspaces géants) |

Pas de changement de schéma DB. Pas de nouvelle dépendance npm (dnd-kit, cmdk, CodeMirror, language-data : déjà présents).

---

## 10. Fichiers à créer / modifier

### Serveur

| Fichier | Rôle |
|---|---|
| `src/server/services/workspace-files.ts` *(nouveau)* | `resolveWorkspaceFilePath` (§ 7), ls/read/write/mkdir/move/copy/delete/upload/search/resolve-paths, `emitWorkspaceChanged` |
| `src/server/services/workspace-files.test.ts` *(nouveau)* | Tests sécurité + conflits (§ 7.8) |
| `src/server/services/file-kind.ts` *(nouveau)* | `isBinary` + `guessMimeType` extraits/partagés (§ 7.7) |
| `src/server/routes/workspace-files.ts` *(nouveau)* | Routes § 6.1–6.8 |
| `src/server/routes/file-storage.ts` | + `POST /from-workspace` (§ 6.9) |
| `src/server/app.ts` | Montage `app.route('/api/agents/:agentId/workspace', …)` |
| `src/server/sse/types.ts` | + `'workspace:changed'` |
| `src/server/tools/filesystem-tools.ts` | `write_file`/`edit_file` → `emitWorkspaceChanged` |
| `src/server/tools/multi-edit-tools.ts` | `multi_edit` → `emitWorkspaceChanged` |
| `src/server/tools/file-storage-tools.ts` | `download_stored_file` → `emitWorkspaceChanged` |
| `src/server/tools/email-tools.ts` | `download_email_attachment` → `emitWorkspaceChanged` |
| `src/server/services/workspace-tree.ts` | `export const IGNORED_DIRS` (une ligne) |
| `src/server/services/file-storage.ts` | `createFileFromWorkspace` durci via le helper § 7 |
| `src/server/services/prompt-builder.ts` | Bloc Workspace : convention chemins cliquables (§ 5.4) |
| `src/server/config.ts` | Section `workspaceFiles` (§ 9) |

### Client

| Fichier | Rôle |
|---|---|
| `src/client/pages/files/FilesPage.tsx` *(nouveau)* | Page, layout, deep-link `/files/:agentId?path=` (+ cas mort § 3.2), garde `beforeunload` |
| `src/client/components/files/WorkspaceTree.tsx` *(nouveau)* | Tree lazy (skeleton/erreur inline), sélection, context/⋯ menus (⋯ toujours visible < `md`), création/rename inline, dnd (pointer fine), dropzone upload |
| `src/client/components/files/FileTabs.tsx` *(nouveau)* | Onglets, dirty, persistance sessionStorage, `UnsavedChangesDialog` |
| `src/client/components/files/WorkspaceEditor.tsx` *(nouveau)* | Composition : viewers selon `kind`, barre de statut, bannières conflit/supprimé — rend le CodeEditor étendu |
| `src/client/components/ui/code-editor.tsx` | + props `filename?` (language-data), `extensions?`, `onSave?` (§ 3.5) |
| `src/client/components/file-storage/FileStorageFormDialog.tsx` | + mode `workspaceSource` + `onSaved(file)` avec payload (§ 4.4) |
| `src/client/hooks/useWorkspaceFiles.ts` *(nouveau)* | Fetch + mutations + handlers SSE (§ 8.2) + `useSSEResync` (pattern `useTasks`) |
| `src/client/hooks/useWorkspaceFileSearch.ts` *(nouveau)* | Clone de `useTicketSearch` sur `/workspace/search` (+ test anti out-of-order) |
| `src/client/lib/file-icons.ts` *(nouveau)* | `getFileIcon(name)` partagé |
| `src/client/lib/remark-workspace-paths.ts` *(nouveau)* | Plugin § 5.2 (text + inlineCode, flag `g`, `ignore: ['link']`) |
| `src/client/lib/remark-workspace-paths.test.ts` *(nouveau)* | Mirror de `remark-ticket-mentions.test.ts` (bornes, inlineCode, faux positifs) |
| `src/client/components/chat/WorkspacePathMention.tsx` *(nouveau)* | Chip (style `MessageFiles`) |
| `src/client/contexts/WorkspacePathContext.tsx` *(nouveau)* | Résolution batchée (emplacement = celui de `TicketMentionContext`) |
| `src/client/components/chat/MentionPopover.tsx` | Groupes (Users / Agents / Files) + nav clavier aplatie |
| `src/client/components/chat/MessageInput.tsx` | Classe de caractères du trigger `@`, gate `isMentionOpen`, branche fichier de `handleMentionSelect` (§ 5.1), consommation draft |
| `src/client/components/chat/MarkdownContent.tsx` | + plugin + `markdownComponents['workspace-path']` + extension de la gate `isPlainText` + prop `disableChatPlugins` |
| `src/client/components/chat/ChatPanel.tsx` / `QuickChatPanel.tsx` | Provider `WorkspacePathContext` (§ 5.2) |
| `src/client/components/chat/ConversationHeader.tsx` + `src/client/components/agent/AgentCard.tsx` | Entrée « Parcourir les fichiers » → `/files/<agentId>` (§ 4.5) |
| `src/client/hooks/useDraftMessage.ts` | Export d'un helper d'append au draft (§ 5.3) |
| `src/client/components/common/KeyboardShortcutsDialog.tsx` | Groupe `files` (§ 3.7) |
| `src/client/components/layout/ActivityBar.tsx` / `AppTopBar.tsx` / `App.tsx` | Entrée nav (icône `Folder`, `activityBar.files`) + `SECTION_PREFIXES`/`sectionPrefixes` + route lazy |
| `src/client/locales/en.json` / `fr.json` | Namespace `files.*` + `shortcuts.*` du groupe files |

### i18n

Namespace `files.*` (aucune collision vérifiée dans en/fr.json) : `files.title`, `files.workspaceOf`, `files.empty.*`, `files.notFound`, `files.tree.*` (newFile, newFolder, upload, rename, duplicate, copy, cut, paste, download, share, insertInChat, copyPath, delete, deleteFolderConfirm, retry), `files.tabs.*`, `files.editor.*` (save, saved, conflict.*, deletedFromDisk, tooLarge, binary, preview), `files.search.placeholder`, `files.share.snapshotNotice`, `files.errors.invalidName`… Réutiliser `common.unsavedChanges.*`, `common.delete`, `common.cancel`. `activityBar.files` dans le namespace existant. Traductions `en` + `fr` dans le même commit que chaque écran.

---

## 11. Phases d'implémentation

Chaque phase est commitable indépendamment (conventional commits), `typecheck` + `test` verts, et laisse l'app dans un état cohérent.

| # | Contenu | Validation |
|---|---|---|
| **P1 — API noyau** | `file-kind.ts`, helper de confinement (+ O_NOFOLLOW), routes `ls`/`file`/`raw` (lecture seule), tests sécurité § 7.8 | `curl` + tests unitaires traversal/symlink-feuille |
| **P2 — Page lecture** | Nav (ActivityBar/AppTopBar/prefixes/route), FilesPage, sélecteur workspace, tree lazy (skeleton + erreurs inline), viewers lecture seule, deep-link (+ cas mort), **entrées fiche agent/conversation**, mobile (Sheet) | Parcourir un vrai workspace à 1440 px et 375 px |
| **P3 — Édition** | `PUT file` (+ `createOnly`) + conflit 409, extension CodeEditor, WorkspaceEditor, onglets + dirty + Ctrl+S + `beforeunload`, aperçu markdown | Éditer pendant qu'un agent écrit le même fichier |
| **P4 — Mutations** | mkdir/move/copy/delete/upload (routes + § 6.6), création/rename inline + validation noms, context/⋯ menus (tactile), F2, dnd intra (pointer fine), dropzone OS, presse-papier inter-workspace | Scénario complet clavier + souris + tactile ; collisions |
| **P5 — SSE** | `workspace:changed` (routes + 5 tools via `emitWorkspaceChanged`), handlers § 8.2 (réconciliation émetteur, préfixes dossier), resync | Demander à un agent de créer/multi-éditer des fichiers, regarder le tree bouger |
| **P6 — Partage** | Route `from-workspace` (+ durcissement `createFileFromWorkspace`), mode `workspaceSource` du dialog, copie presse-papier | URL ouverte en navigation privée |
| **P7 — Chat** | Palette `@` groupée (3 changements MessageInput) + search hook (+ test), plugin remark (+ test) + chips + contexte batché + gate isPlainText, « Insérer dans le chat » (draft), bloc prompt | Mention → l'agent lit le fichier ; chemin dans une réponse → chip → ouvre Files ; nom avec espaces/accents |
| **P8 — Quick open & polish** | Ctrl+P (cmdk), raccourcis + KeyboardShortcutsDialog, audit 18 palettes × light/dark × contrastes | Revue DesignSystemPage côte à côte |
| **P9 — Livrables périphériques** | § 12 complet | — |

---

## 12. Livrables périphériques (exigés — règle n°12, demande fondateur)

| Livrable | Contenu |
|---|---|
| **`api.md`** | Toutes les routes § 6 au format canonique + event `workspace:changed` dans la section SSE |
| **`config.md`** | Table § 9 |
| **docs-site (Starlight)** | Nouvelle page guide « Files / Workspace browser » : tour de la page, édition & conflits, partage (sémantique snapshot), mentions `@` et chemins cliquables, raccourcis, limites configurables. Mise à jour de la page existante sur les workspaces agents (mention de l'accès UI) |
| **Site marketing (`site/`, Astro)** | Ajout de la feature dans la section features (description courte + capture de la page Files — respecter la préférence design : motif honeycomb, pas de glow superflu) |
| **GitHub (README)** | Bullet feature + capture dans la section screenshots si présente |
| **Prompt système** | § 5.4 (fait en P7, rappelé ici comme livrable) |
| **`CLAUDE.md`** | Ligne `files.md` dans la table « Documentation map » |

---

## 13. Hors périmètre v1 (notés pour v2)

> **Lot UX post-v1 livré** (branche `ux-loop-improvements`) : réordonnancement d'onglets (drag), menu contextuel d'onglet, sélecteur de source recherchable + segments, **mini-apps comme source éditable**, fil d'Ariane cliquable, recherche dans le fichier + go-to-line, barre de statut (curseur/langage) + toggle word-wrap, filtre d'arbre + tout déplier/replier, **panneau gauche redimensionnable** (splitter maison, sans `react-resizable-panels`), **vue diff git par fichier** + **panneau des fichiers modifiés**, rouvrir l'onglet fermé (`Ctrl+Shift+T`), révéler le fichier actif, visionneuse image (zoom/pan/fit). Les lignes ci-dessous restent ouvertes.

- **Unification file-storage dans l'explorateur** (racine supplémentaire) — le file-storage est plat et a une sémantique partage/expiry différente ; on garde l'idée.
- `fs.watch` temps réel par workspace (couvrir les mutations `run_shell`) — design d'abonnement nécessaire.
- Onglets « preview » (simple clic remplaçable, italique) — pas d'équivalent tactile du double-clic d'épinglage.
- Multi-sélection dans le tree ; split view ; auto-save ; auto-révélation du fichier actif au changement d'onglet (bouton manuel livré, auto jugé intrusif).
- Recherche **dans le contenu** des fichiers (grep UI) — seul le nom/chemin est cherché en v1.
- Chips de chemins hors conversations (TaskResultCard…) : nécessite un provider par surface.
- Tool agent `notify_file` — probablement couvert par la convention prompt.
- Corbeille / undo de suppression (suppression définitive en v1, assumée via AlertDialog explicite).
- Édition collaborative temps réel (CRDT) — le conflit 409 + bannières suffisent à l'échelle d'un foyer/petit groupe.
- Mitigation hardlinks (filesystem séparé pour `data/workspaces`) — risque résiduel documenté § 7.6.

## 14. Questions résolues

| Question | Décision |
|---|---|
| Monaco vs CodeMirror | CodeMirror (poids, thème palettes existant, mobile) |
| Nom de la section | `Files` (« workspace » = la racine par agent, dans la page) |
| Onglets multiples | Oui, légers, état client, tous épinglés (preview = v2) |
| Scope du browser | Page globale + sélecteur + entrées contextuelles pré-scopées |
| Accès | Tous les utilisateurs authentifiés |
| Inter-workspace | Copier/coller applicatif (pas de drag inter-workspace ; tactile = couper/coller aussi) |
| Format de mention de fichier dans le chat | Chemin relatif **entre backticks** (espaces/accents délimités) ; rendu cliquable par plugin + vérification d'existence batchée |
| Modification du prompt système | Oui (§ 5.4) ; pas de nouveau tool agent en v1 |
| Nouvelle table DB | Non |
| Code erreur agent | `KIN_NOT_FOUND` (convention existante, renommage différé au rebrand global) |
| Éditeur : fork ou extension | Extension de `code-editor.tsx` (3 props) ; `WorkspaceEditor` = composition seulement |
| Partage : nouveau dialog ? | Non — mode `workspaceSource` ajouté à `FileStorageFormDialog` |
| Fermer l'onglet au clavier | `Alt+W` + clic molette (`Ctrl+W` = réservé navigateur, non interceptable) |
