# Fichiers du workspace depuis le chat

Le bouton **Fichiers**, dans la barre du champ de message, ouvre le workspace de l’Agent dans un panneau. Le nom de l’Agent et la portée partagée restent visibles. Le sélecteur de modèle conserve son nom seul.

## Parcours

- Parcourir les dossiers ou rechercher un fichier par son nom ou son chemin dans tout le workspace. Les résultats sont limités à 50, avec une invitation à préciser la recherche.
- Importer plusieurs fichiers dans le dossier affiché, avec le bouton ou par glisser-déposer. Les chemins renvoyés par le serveur sont utilisés, y compris le nom distinct attribué en cas de doublon. Les imports réussis restent sélectionnés si d’autres échouent.
- Sélectionner des fichiers dans plusieurs dossiers, consulter la sélection, la modifier, puis **Ajouter au message**. Le texte déjà saisi est conservé, les chemins sont insérés dans le brouillon et le focus revient au champ de message. L’envoi reste explicite.
- Télécharger un fichier directement depuis sa ligne. L’éditeur complet reste accessible dans Productions → Fichiers.

Les références sont des chemins dans le workspace existant : elles permettent à l’Agent d’utiliser ses outils de lecture. Elles ne figent pas une copie du contenu. Les imports, eux, sont enregistrés immédiatement dans le workspace, même si le panneau est ensuite fermé sans ajouter de référence au brouillon.

## Sessions privées

Les fichiers existants du workspace partagé peuvent être référencés dans le brouillon privé. Le bouton d’import est remplacé par **Joindre un fichier privé**, qui utilise le stockage et les permissions de la session. Ces fichiers ne sont pas déposés dans le workspace partagé. Le panneau et ses événements de glisser-déposer restent isolés du champ de message situé derrière lui.

## Implémentation

Le panneau réutilise les API existantes de fichiers : aucun changement du serveur, du schéma ou des droits. Il charge les dossiers à l’ouverture et la recherche à la demande. Les erreurs de recherche permettent de réessayer ; une réponse arrivée après la fermeture ou l’effacement de la recherche est ignorée. Le brouillon continue d’utiliser le stockage par compte et conversation.

Le contenu du panneau défile indépendamment de son bouton d’ajout, qui reste visible sur les écrans courts. Les boutons et leurs états de sélection sont accessibles au clavier ; les libellés existent en français et en anglais.

## Vérification

`bun run test:e2e:chat-files` couvre le parcours avec un serveur, une base et des fichiers temporaires, et un fournisseur simulé : navigation, sélection, brouillon après rechargement, import dans un sous-dossier, doublon, échec partiel et reprise, dépôt, téléchargement, chemins réellement reçus dans le message, recherche en erreur et réponse obsolète, changement d’Agent, pièces jointes privées et refus d’accès à un autre membre. La suite vérifie aussi le format 320 × 640 en français/anglais et clair/sombre. Elle est ajoutée à la CI.

Les tests de Markdown vérifient que les chemins contenant des accents, espaces et backticks restent intacts jusqu’aux liens rendus dans les messages. Les rapports et captures sont conservés dans [le dossier de validation](refonte/chat-files-2026-09-17/).

Résultats de cette passe : typage et build réussis ; 45 tests ciblés réussis ; 6 parcours de la nouvelle suite, 14 parcours workspace avec leurs budgets JavaScript et 4 parcours de continuité réussis. Aucune exception navigateur relevée. Les contrôles utilisent des données synthétiques et ne constituent pas un audit complet des lecteurs d’écran ou des claviers virtuels.
