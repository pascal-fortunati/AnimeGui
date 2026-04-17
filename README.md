<div align="center">
  <img src="src/assets/logo_up.png" alt="AnimeGui Logo" width="500">
</div>

# AnimeGui - Upscaleur & Encodeur Vidéo IA

Application de bureau puissante pour upscaler et encoder des vidéos et du contenu anime avec l'IA, construite avec Tauri, React et Rust.

[Version: 0.1.0] [Licence: MIT] [Plateforme: Windows]

## Fonctionnalités

### Traitement Vidéo Principal
- **Upscaling IA**: Utilise RealCUGAN pour l'upscaling vidéo haute qualité (2x, 4x)
- **Encodage Avancé**: Support des codecs H.264, H.265 (HEVC) et AV1
- **Présets de Qualité**: 
  - Anime HD (upscale 2x, H.265, CRF 18)
  - Old DVD (upscale 4x, H.265, CRF 20)
  - Haute Qualité (upscale 4x, AV1, CRF 16 + mode TTA)
- **Réduction du Bruit**: Niveaux de débruitage configurables (0-3)
- **Traitement Batch**: Système de queue pour traiter plusieurs fichiers
- **Accélération Matérielle**: Détection du support GPU (NVIDIA/AMD/Intel)

### Outils Sous-titres DVD
- **Extraction Sous-titres DVD**: Extrait les pistes de sous-titres DVD des fichiers vidéo
- **Traitement OCR**: 
  - Reconnaissance optique de caractères automatique avec Tesseract
  - Support multi-langue (Français, Anglais, etc.)
  - Scoring de confiance et interface de correction manuelle
  - Dictionnaire de remplacements OCR personnalisable
- **Export SRT**: Génère des fichiers SRT de sous-titres à partir des sous-titres DVD
- **Aperçu Temps Réel**: Visualisez les résultats OCR et corrections en temps réel

### Fonctionnalités Avancées
- **Aperçu Temps Réel**: Analysez les propriétés vidéo et prévisualisez frame par frame
- **Outil Recadrage**: Définissez des régions de recadrage avant l'encodage
- **Sélection Audio/Sous-titres**: Choisissez les pistes à conserver
- **File d'Attente**: Surveillez et gérez plusieurs tâches d'encodage
- **Persistance des Paramètres**: Sauvegardez et appliquez des profils de traitement personnalisés
- **Interface Multi-fenêtre**: Fenêtres séparées pour aperçu, traitement DVD et monitoring

## Démarrage Rapide

### Configuration Requise

- **Windows 10/11**
- **Node.js** (v18+) et gestionnaire de paquets **Bun**
- **Rust** (1.70+)
- **FFmpeg** (fourni)
- **Git**

### Outils Externes (Fournis)

Les outils suivants sont groupés dans le répertoire `tools/`:
- **FFmpeg** - Traitement vidéo
- **Tesseract** - Moteur OCR
- **RealCUGAN** - Modèles d'upscaling IA
- **MKVExtract** - Manipulation de conteneurs

### Installation

```bash
# Cloner le dépôt
git clone https://github.com/pascal-fortunati/AnimeGui.git
cd AnimeGui

# Installer les dépendances
bun install

# Installer les dépendances Rust
cd src-tauri && cargo fetch
cd ..

# Construire l'application (mode développement)
bun run tauri dev

# Construire pour la production
bun run tauri build
```

### Premier Lancement

1. L'application démarre avec une **Fenêtre de Boot** (état de chargement)
2. La fenêtre principale s'initialise avec:
   - Panneau File (gauche): Liste des tâches à traiter
   - Panneau Paramètres (haut-droit): Configurez les paramètres d'encodage
   - Panneau Monitoring (bas-droit): Progression d'encodage en temps réel
   - Sélecteur de fichiers: Choisissez le fichier vidéo d'entrée ou le répertoire

## Utilisation

### Flux de Travail Encodage Basique

1. **Sélectionnez l'Entrée**
   - Cliquez sur le bouton de fichier ou glissez-déposez un fichier vidéo
   - Ou sélectionnez un dossier pour le traitement batch

2. **Configurez les Paramètres**
   - Choisissez le préset de qualité (Anime HD, Old DVD, Haute Qualité)
   - Ajustez le facteur d'upscale, le niveau de débruitage, le codec et le débit
   - Définissez le répertoire de sortie

3. **Aperçu (Optionnel)**
   - Cliquez sur "Aperçu" pour analyser les propriétés vidéo
   - Visualisez frame par frame avec recadrage et sélection de piste
   - Ajustez les préférences audio/sous-titres

4. **Traitement**
   - Ajoutez la tâche à la file (par défaut) ou traitez immédiatement
   - Surveillez la progression dans le panneau Monitoring
   - Les tâches peuvent être mises en pause, reprises ou annulées

### Traitement Sous-titres DVD

1. **Extraire les Sous-titres DVD**
   - Dans la fenêtre Aperçu, si une piste de sous-titres DVD est détectée
   - Cliquez sur le bouton "Ouvrir DVD Subtitles"

2. **Traitement OCR**
   - Sélectionnez la piste de sous-titres à extraire
   - Configurez la langue OCR et le facteur d'upscale
   - Démarrez le traitement batch OCR

3. **Examen & Correction**
   - Visualisez chaque sous-titre extrait avec le score de confiance
   - Corrigez manuellement les entrées à faible confiance
   - Le système apprend à partir des corrections

4. **Export**
   - Exportez les sous-titres corrigés en fichier SRT
   - SRT automatiquement intégré à la tâche d'encodage
   - La fenêtre Aperçu se réouvre avec le SRT prêt

## Architecture de l'Interface

### Fenêtres

| Fenêtre | Objectif | Paramètre de Requête |
|---------|----------|----------------------|
| **Main** | File de tâches, paramètres, monitoring | (par défaut) |
| **Boot** | Chargement/initialisation | `?boot=1` |
| **Aperçu** | Analyse vidéo & configuration | `?preview=1` |
| **Sous-titres DVD** | Extraction DVD & OCR | `?dvdsubs=1` |

### Flux de Données

```
Entrée Utilisateur (fichier/dossier)
    |
    v
[Fenêtre Main] -> Configuration Paramètres
    |
    v
[Fenêtre Aperçu] (optionnel) -> Sélection Recadrage/Piste
    |
    v
[Fenêtre Sous-titres DVD] (si DVD détecté) -> OCR -> Export SRT
    |
    v
[File] -> [Pipeline Encodage] -> Vidéo de Sortie
```

### Gestion du Contexte

L'état de l'application est persisté via localStorage:

- `animegui-preview-context` - Analyse vidéo, pistes sélectionnées, chemin SRT
- `animegui-dvdsubs-context` - État d'extraction DVD, lignes OCR
- `animegui-preview-state-{id}` - Index de frame et état de session aperçu

## Développement

### Structure du Projet

```
AnimeGui/
├── src/                          # Frontend React/TypeScript
│   ├── components/
│   │   ├── Boot/                # Fenêtre d'initialisation
│   │   ├── Preview/             # Aperçu vidéo & analyse
│   │   ├── DvdSubs/             # Outils sous-titres DVD
│   │   ├── Queue/               # Panneau file
│   │   ├── Settings/            # Panneau configuration
│   │   ├── Monitor/             # Monitoring de progression
│   │   └── ui/                  # Composants UI réutilisables
│   ├── api.ts                   # Liaisons commandes Tauri
│   ├── types.ts                 # Définitions types TypeScript
│   └── main.tsx                 # Point d'entrée React
├── src-tauri/                    # Backend Rust
│   ├── src/
│   │   ├── lib.rs               # Commandes Tauri principales
│   │   ├── analyzer.rs          # Analyse vidéo
│   │   ├── encoder.rs           # Encodage FFmpeg
│   │   ├── vobsub.rs            # Extraction sous-titres DVD
│   │   ├── monitor.rs           # Monitoring de progression
│   │   ├── pipeline.rs          # Pipeline de traitement
│   │   ├── queue.rs             # Gestionnaire file
│   │   ├── upscaler.rs          # Intégration RealCUGAN
│   │   ├── preview.rs           # Génération aperçu frame
│   │   └── remuxer.rs           # Remuxing de conteneur
│   ├── tauri.conf.json          # Configuration Tauri
│   └── capabilities/            # Capacités sécurité
├── tools/                        # Outils externes (groupés)
│   ├── ffmpeg/
│   ├── tesseract/
│   ├── realcugan/
│   └── mkvextract/
└── public/                       # Ressources statiques
```

### Stack Technologique

- **Frontend**: React 18, TypeScript, TailwindCSS
- **Backend**: Rust, Tauri 2, Tokio
- **Bundler**: Vite
- **Gestionnaire de Paquets**: Bun
- **Traitement Vidéo**: FFmpeg
- **Upscaling IA**: RealCUGAN
- **OCR**: Tesseract

### Technologies Clés

#### Commandes Tauri (Frontend <-> Backend)
- Analyse vidéo: `analyze_file()`
- Gestion des tâches: `add_job()`, `start_job_or_batch()`, `cancel_job()`
- Traitement DVD: `scan_dvd_subtitle_tracks()`, `extract_dvd_subtitle_tracks()`, `ocr_dvd_sub_line()`
- Corrections OCR: `record_ocr_correction()`, `upsert_ocr_user_replacement()`

#### Gestion Multi-fenêtre
- `getCurrentWindow()` - Obtenir le handle de la fenêtre actuelle
- `WebviewWindow.getByLabel()` - Trouver des fenêtres par label
- Contrôle de la visibilité des fenêtres pour les transitions de flux

#### Patterns Asynchrones
- Backend Rust async basé sur Tokio
- JavaScript async basé sur Promises
- Émission de progression en temps réel via événements Tauri

### Construction

```bash
# Build développement
bun run dev              # Mode watch avec hot reload

# Build production
bun run build            # Binaire release optimisé
bun run tauri build      # Build Tauri complète

# Vérification des types
bun run check-types      # Validation TypeScript
cargo check              # Vérification compilation Rust

# Linting
bunx eslint src/         # Linting JavaScript/TypeScript
```

## Considérations de Performance

### Fonctionnalités d'Optimisation

- **Chargement Différé**: Les pistes vidéo ne sont chargées que à la demande
- **Mise en Cache**: Images OCR mises en cache pour éviter la ré-extraction
- **Support GPU**: Détection automatique des encodeurs matériels
- **Opérations Batch**: Système de file pour un traitement efficace
- **Analyse Incrémentale**: Analyse de frame mise en cache par session

### Limitations Connues

- Extraction de sous-titres DVD limitée à 5000 images par batch
- Le temps de traitement OCR dépend du nombre d'images (~1min par 50 images)
- Les fichiers vidéo volumineux (>10GB) peuvent nécessiter plus de RAM système
- L'upscaling IA nécessite 4GB+ de VRAM pour des performances optimales

## Dépannage

### Problèmes Courants

| Problème | Solution |
|----------|----------|
| "tesseract.exe introuvable" | Vérifiez que le répertoire `tools/tesseract/` existe |
| La fenêtre des sous-titres DVD ne s'ouvre pas | Vérifiez les capacités des fenêtres Tauri (voir `src-tauri/capabilities/default.json`) |
| L'encodage se fige | Vérifiez la disponibilité de FFmpeg, redémarrez l'application |
| Faible confiance OCR | Ajustez le facteur d'upscale OCR (2 ou 3) dans la fenêtre DVD |
| GPU non détecté | Mettez à jour les pilotes vidéo, assurez-vous que les encodeurs matériels sont disponibles |

### Journaux de Débogage

- Frontend: Ouvrez DevTools (F12) pour la sortie console
- Backend: Vérifiez `stdout.txt` à la racine du projet
- Journaux Tauri: Disponibles dans le terminal lors de l'exécution de `bun run dev`

## Sécurité

- Environnement de fenêtre Tauri sandboxé
- Accès au système de fichiers restreint aux répertoires configurés
- Le système de capacités Tauri applique le modèle de permissions
- Aucun appel réseau externe (complètement hors ligne)

## Contribution

Les contributions sont les bienvenues! Veuillez:

1. Forker le dépôt
2. Créer une branche de fonctionnalité (`git checkout -b feature/amazing-feature`)
3. Valider les modifications (`git commit -m 'Add amazing feature'`)
4. Pousser vers la branche (`git push origin feature/amazing-feature`)
5. Ouvrir une Pull Request

### Directives de Développement

- Suivez le style de code existant (utilisez les configs Prettier/ESLint)
- Ajoutez des tests pour les nouvelles fonctionnalités
- Mettez à jour la documentation et le README
- Utilisez les messages de commit conventionnels

## Licence

Ce projet est licencié sous la Licence MIT - voir le fichier [LICENSE](LICENSE) pour les détails.

## Remerciements

- [Tauri](https://tauri.app/) - Framework d'application de bureau
- [RealCUGAN](https://github.com/bilibili/RealCUGAN) - Modèles d'upscaling IA
- [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) - Moteur OCR
- [FFmpeg](https://ffmpeg.org/) - Traitement vidéo

## Support

Pour les problèmes, questions ou demandes de fonctionnalités:

- Ouvrez une [Issue](https://github.com/yourousername/AnimeGui/issues)
- Démarrez une [Discussion](https://github.com/yourousername/AnimeGui/discussions)
- Contact: your-email@example.com

## Roadmap

- [ ] Support Linux/macOS
- [ ] WebUI pour opération à distance
- [ ] Système de plugins pour filtres personnalisés
- [ ] Outils avancés de correction des couleurs
- [ ] Encodage de flux en temps réel
- [ ] Support multi-GPU

---

Construit pour les fans d'anime et de vidéos