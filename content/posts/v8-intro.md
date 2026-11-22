---
title: V8 - le moteur, les sources, la compilation
date: 2026-11-22
level: 1
tags: v8, javascript, browser, pwn
excerpt: Premier post d'une série sur V8. Ce qu'est le moteur, comment récupérer les sources, comment les compiler, et les fichiers qui comptent pour le build.
---

Premier post d'une série sur **V8**. Avant de parler de bugs, de `TurboFan` ou d'exploitation, il faut un environnement de travail : savoir ce qu'est le moteur, où est le code, et comment en sortir un binaire qu'on peut lancer et débugger. C'est l'objet de ce post.

## C'est quoi V8

**V8** est le moteur **JavaScript** (et **WebAssembly**) de Google, écrit en **C++**. C'est lui qui prend du JS, le compile et l'exécute. On le trouve dans :

- **Chrome** / **Chromium** et tous les navigateurs basés dessus (Edge, Brave, Opera...) ;
- **Node.js**, **Deno**, **Electron** ;
- des runtimes serverless comme **Cloudflare Workers**.

Autrement dit, un bug dans V8 touche une surface énorme, ce qui en fait une cible de choix côté pwn / browser exploitation. L'architecture interne du moteur (l'interpréteur, les étages de JIT, le GC) fera l'objet d'un post dédié, ici on se concentre sur **récupérer, compiler et débugger** le moteur.

## Open source

V8 est **open source** sous licence **BSD** (permissive). Il fait partie de l'écosystème **Chromium** et vit sur l'infra Google :

- source : <https://chromium.googlesource.com/v8/v8.git>
- miroir GitHub (lecture) : <https://github.com/v8/v8>
- doc officielle : <https://v8.dev/docs>

Le développement se fait via **Gerrit** (code review Chromium), pas via des PR GitHub : le dépôt GitHub n'est qu'un miroir.

## Récupérer les sources

On **ne clone pas** simplement le repo git : V8 a des dépendances tierces (build toolchain, libs) gérées par l'outillage Chromium. Il faut passer par **`depot_tools`**.

### 1. depot_tools

```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PATH:/chemin/vers/depot_tools"   # à mettre dans ton .bashrc / .zshrc
```

`depot_tools` fournit `fetch`, `gclient`, `gn`, `ninja`, etc.

### 2. fetch

```bash
mkdir ~/v8 && cd ~/v8
fetch v8
cd v8
```

`fetch v8` clone le dépôt **et** lance un premier `gclient sync` qui télécharge toutes les dépendances déclarées dans le fichier **`DEPS`**. C'est long la première fois.

### 3. dépendances système (Linux)

```bash
./build/install-build-deps.sh
```

### 4. se placer sur une version précise

Pour bosser sur une version donnée (reproduire un bug, suivre un writeup...) :

```bash
git checkout <tag_ou_commit>
gclient sync          # resync les deps pour CE commit
```

Le `gclient sync` après un `checkout` est **important** : les dépendances tierces sont épinglées par commit, les oublier casse le build.

## Compiler

V8 utilise **GN** pour générer les fichiers de build et **Ninja** pour compiler.

### La voie rapide : gm.py

Le script `tools/dev/gm.py` ("gn + ninja magic") génère la config **et** compile en une commande. On l'aliase souvent :

```bash
alias gm=~/v8/tools/dev/gm.py

gm x64.release        # build release
gm x64.debug          # build debug (assertions, DCHECK, plus lent)
gm x64.release d8     # ne build que la cible d8
```

Ça crée automatiquement `out/x64.release/` avec des `args.gn` par défaut sains.

### La voie manuelle : gn + ninja

Pour contrôler finement les options (typiquement pour un build **pwn**) :

```bash
gn gen out/pwn                       # crée le dossier de build
# on édite out/pwn/args.gn (voir plus bas)
ninja -C out/pwn d8                  # compile la cible d8
```

### Le binaire qui nous intéresse : d8

La cible **`d8`** est le **shell développeur** de V8 : un exécutable autonome qui lance du JS sans navigateur. C'est **l'outil de référence** pour tester, débugger et exploiter.

```bash
./out/x64.release/d8
d8> console.log("hello v8")
```

Le flag qu'on garde tout le temps sous la main, c'est **`--allow-natives-syntax`** : il débloque les **native functions** (`%DebugPrint`, `%OptimizeFunctionOnNextCall`, `%SystemBreak`...), des pseudo-fonctions préfixées par `%` qui donnent un accès direct aux internals. On s'en sert dans la section suivante.

## Les fichiers qui comptent pour le build

| Fichier | Rôle |
| --- | --- |
| **`DEPS`** | Déclare les dépendances tierces et leur commit épinglé. Lu par `gclient sync`. |
| **`.gn`** | Point d'entrée GN (racine du projet de build). |
| **`BUILD.gn`** | Le gros fichier de build : cibles (`d8`, `v8_libbase`...), sources, flags de compilation. Il y en a plein, un par dossier. |
| **`out/<cfg>/args.gn`** | **Le** fichier à éditer : les arguments de build (debug/release, options d'introspection). |
| **`gni/`** | Includes GN partagés (`v8.gni`, etc.) qui factorisent la config. |
| **`tools/dev/gm.py`** | Le wrapper gn+ninja de confort. |

### Un args.gn orienté pwn

Pour débugger / exploiter, on veut un **release** (réaliste, c'est ce que tourne en prod) mais avec les helpers d'introspection activés :

```gn
# out/pwn/args.gn
is_debug = false
target_cpu = "x64"
v8_enable_backtrace = true
v8_enable_disassembler = true      # désassemblage du code JIT
v8_enable_object_print = true      # %DebugPrint lisible
v8_enable_verify_heap = true       # vérif d'intégrité du tas (pratique en debug d'exploit)
symbol_level = 2                   # symboles pour gdb
```

Après édition :

```bash
gn gen out/pwn
ninja -C out/pwn d8
```

## Introspection : d'un objet JS à la mémoire brute

Le point le plus important du setup : savoir **regarder un objet en mémoire**. On va passer du même objet vu par V8 (`%DebugPrint`), puis par gdb (`job`), puis en octets (`x/gx`), et montrer que c'est **la même chose** à trois niveaux de zoom.

### %DebugPrint dans d8

On prend un tableau de **floats** :

```js
// pwn.js
let a = [1.1, 2.2, 3.3];
%DebugPrint(a);
```

```bash
./d8 --allow-natives-syntax pwn.js --shell
```

```
DebugPrint: 0x301e0104a5b9: [JSArray]
 - map: 0x301e0100bec9 <Map[16](PACKED_DOUBLE_ELEMENTS)> [FastProperties]
 - prototype: 0x301e0100b835 <JSArray[0]>
 - elements: 0x301e0104a599 <FixedDoubleArray[3]> [PACKED_DOUBLE_ELEMENTS]
 - length: 3
 - properties: 0x301e000007e5 <FixedArray[0]>
 - elements: 0x301e0104a599 <FixedDoubleArray[3]> {
           0: 1.1 (0x3ff199999999999a)
           1: 2.2 (0x400199999999999a)
           2: 3.3 (0x400a666666666666)
 }
0x301e0100bec9: [Map] in OldSpace
 - type: JS_ARRAY_TYPE
 - instance size: 16
 - elements kind: PACKED_DOUBLE_ELEMENTS
 - back pointer: 0x301e0100be85 <Map[16](HOLEY_SMI_ELEMENTS)>
 ...

V8 version 15.7.0 (candidate)
```

Quatre choses à retenir, sans rien connaître des internals :

- **`0x301e0104a5b9`**, l'adresse **taguée** du `JSArray`. Elle finit par `9` (impair) : le **bit de poids faible est à 1**, c'est le *tag* « ceci est un pointeur d'objet », pas un entier. On s'en resservira pour lire la mémoire.
- **`map`** → `PACKED_DOUBLE_ELEMENTS` : la **Map** décrit la *forme* de l'objet. Ici elle dit « tableau dont les éléments sont des doubles ». La Map est la structure centrale côté exploit.
- **`elements`** → un `FixedDoubleArray` **séparé** : le JSArray ne contient pas ses valeurs, il **pointe** vers un backing store dédié aux doubles.
- **`length`** : 3.

Un objet V8, c'est donc une petite **chaîne de structures** : le `JSArray` (en-tête fixe) pointe vers sa `Map` (la forme) et vers son `elements` (les données).

![Chaîne JSArray → Map / FixedDoubleArray](assets/v8-anatomie-jsarray.svg)

### La même vue dans gdb

V8 fournit un script gdb avec des commandes toutes faites. On le source une fois dans `~/.gdbinit` :

```bash
echo "source /chemin/vers/v8/tools/gdbinit" >> ~/.gdbinit
```

Pour inspecter, il faut l'objet **vivant** et le process **arrêté**. Le plus simple : `%SystemBreak()` juste après le `%DebugPrint`, ça exécute un `int3` que gdb attrape.

```js
let a = [1.1, 2.2, 3.3];
%DebugPrint(a);
%SystemBreak();     // -> SIGTRAP, gdb reprend la main
```

Une fois sur le breakpoint, on redonne l'adresse crachée par `%DebugPrint` à la commande **`job`** (*JavaScript object*) :

```
pwndbg> job 0x301e0104a5b9
0x301e0104a5b9: [JSArray]
 - map: 0x301e0100bec9 <Map[16](PACKED_DOUBLE_ELEMENTS)> [FastProperties]
 - prototype: 0x301e0100b835 <JSArray[0]>
 - elements: 0x301e0104a599 <FixedDoubleArray[3]> [PACKED_DOUBLE_ELEMENTS]
 - length: 3
 - properties: 0x301e000007e5 <FixedArray[0]>
 - All own properties (excluding elements): {
    0x301e00000e39: [String] in ReadOnlySpace: #length: 0x301e001c6739 <AccessorInfo name= 0x301e00000e39 <String[6]: #length>, data= 0x301e00000011 <undefined>> (const accessor descriptor, attrs: [W__])
 }
 - elements: 0x301e0104a599 <FixedDoubleArray[3]> {
           0: 1.1 (0x3ff199999999999a)
           1: 2.2 (0x400199999999999a)
           2: 3.3 (0x400a666666666666)
 }
```

**Output identique à `%DebugPrint`**, normal : les deux appellent la même fonction C++, `_v8_internal_Print_Object`. `job` n'est qu'un alias, et on peut l'appeler à la main :

```
pwndbg> p _v8_internal_Print_Object((void*)0x301e0104a5b9)   # ce que fait `job`
```

### En mémoire

`job` et `%DebugPrint` donnent des adresses, `x/gx` montre les octets derrière. Un point à voir avant, **le « 1 »** : l'adresse `0x301e0104a5b9` finit par un chiffre **impair**. Son **bit de poids faible vaut 1**, et ce bit est un *tag* : il dit à V8 « ceci est un pointeur vers un objet du tas », pas un entier (un `Smi` a ce bit à 0). L'objet commence donc **une adresse plus bas**, à `…a5b8` : dans gdb on lit toujours à **`adresse − 1`**.

Même code couleur sur chaque champ de `%DebugPrint` et sur ses **4 octets** côté gdb :

<div class="term term-fig" aria-label="Correspondance DebugPrint / octets gdb">
<span class="cm"># d8 --allow-natives-syntax pwn.js</span>
<span class="pr">DebugPrint:</span> <span class="f-addr">0x301e0104a5b<span class="f-tag b" data-f="tag" title="bit 0 = 1 : tag objet du tas">9</span></span>: [JSArray]
  - <span class="f-map" data-f="map">map</span>        <span class="f-map" data-f="map">0x301e0100bec9</span>
  - <span class="f-elem" data-f="elem">elements</span>   <span class="f-elem" data-f="elem">0x301e0104a599</span>
  - <span class="f-len" data-f="len">length</span>     <span class="f-len" data-f="len">3</span>
  - <span class="f-prop" data-f="prop">properties</span> <span class="f-prop" data-f="prop">0x301e000007e5</span>
<span class="rule">──────────────────────────────────────────────</span>
<span class="pr">pwndbg&gt;</span> x/2gx 0x301e0104a5b9 <span class="f-tag" data-f="tag">- 1</span>     <span class="cm"># JSArray : on retire le tag</span>
0x301e0104a5b8:  <span class="b f-prop" data-f="prop">000007e5</span> <span class="b f-map" data-f="map">0100bec9</span>   <span class="b f-len" data-f="len">00000006</span> <span class="b f-elem" data-f="elem">0104a599</span>
<span class="rule">──────────────────────────────────────────────</span>
<span class="pr">pwndbg&gt;</span> x/4gx 0x301e0104a599 <span class="f-tag" data-f="tag">- 1</span>     <span class="cm"># FixedDoubleArray : les données</span>
0x301e0104a598:  <span class="b f-len" data-f="len">00000003</span> <span class="b f-map" data-f="map">0000095d</span>   <span class="b f-dbl" data-f="dbl">3ff199999999999a</span>  <span class="cm">&lt;- 1.1</span>
0x301e0104a5a8:  <span class="b f-dbl" data-f="dbl">400199999999999a</span>    <span class="b f-dbl" data-f="dbl">400a666666666666</span>  <span class="cm">&lt;- 2.2 / 3.3</span>
</div>

<p class="term-cap">Les octets gdb sont en <b>little-endian</b> : dans un qword imprimé, le champ de droite est à l'offset le plus bas. <code>000007e5`0100bec9</code> = <span style="color:#bdbdbd">properties</span> (gauche) + <span style="color:#3fd0ff">map</span> (droite, offset +0).</p>

On retrouve **exactement** les valeurs de `%DebugPrint`, mais en octets. Chaque champ ne fait que **4 octets** (la moitié basse de l'adresse) : c'est la **pointer compression**. V8 reconstruit l'adresse complète en ajoutant la base d'une région mémoire, la *cage*, ici `0x301e00000000` (`0100bec9` → `0x301e0100bec9`). On la décrit en bref juste en dessous ; les protections qu'elle pose, elles, font l'objet du post suivant. Les doubles, eux, font **8 octets bruts**.

Deux détails qui comptent déjà :

- Les `length` ne s'encodent pas pareil : celui du `JSArray` est un **Smi** (3 → `0x6`, soit `3<<1`), celui du `FixedDoubleArray` est un **entier brut** (`3`).
- Les éléments `1.1 / 2.2 / 3.3` sont posés **tels quels**, en IEEE-754 sur 8 octets, **ni tagués ni compressés**. C'est toute la différence.

Le workflow qu'on réutilisera dans toute la série tient en une ligne : **`%DebugPrint` → une adresse → `job` pour relire → `x/gx` sur `addr − 1` pour les octets.**

### La cage, en bref

La **cage** (*pointer compression cage*) est ce qui rend cette compression possible. Trois points d'architecture suffisent ici :

- c'est une **réservation contiguë de 4 Go** (`0x100000000`), alignée, placée à une base aléatoire au démarrage (ASLR) ; dans ce run, `0x301e00000000` ;
- **tous les objets du tas JS vivent dedans** : `JSArray`, `Map`, `FixedArray`, `FixedDoubleArray`... Leur moitié haute d'adresse est donc **toujours** la base de la cage ;
- V8 ne stocke alors que les **32 bits de poids faible** et reconstruit l'adresse par `base + offset`. C'est exactement ce qu'on vient de lire en octets.

Conséquence qu'on exploitera plus loin : un champ pointeur compressé ne peut désigner qu'une adresse **dans les 4 Go de la cage**, jamais au-delà. C'est la première pierre d'un modèle de sécurité plus large, le **sandbox**, avec ses tables de pointeurs (EPT/TPT) pour ce qui doit vivre dehors :

![La cage dans le sandbox, les tables EPT/TPT dehors](assets/v8-archi-overview.svg)

On le détaille au post suivant.


## Les tableaux d'objets

Un tableau de doubles contient des **valeurs**. Un tableau d'objets, lui, contient des **adresses**. C'est ce qui le rend intéressant en pwn.

On reprend un tableau de floats, `o1`, et on le range dans un tableau d'objets à côté d'un objet vide :

```js
let o1 = [1.1, 1.2, 1.3];
let a  = [o1, {}];
%DebugPrint(o1);
%DebugPrint(a);
%SystemBreak();
```

<div class="term term-fig" aria-label="Le pointeur de o1 dans le tableau d'objets">
<span class="pr">DebugPrint:</span> <span class="f-o1" data-f="o1">0x3fa50104a5e9</span>: [JSArray]                  <span class="cm"># o1</span>
  - map:      0x3fa50100bec9 &lt;Map[16](PACKED_DOUBLE_ELEMENTS)&gt;
  - elements: 0x3fa50104a5c9 &lt;FixedDoubleArray[3]&gt;
  - length:   3
<span class="rule">──────────────────────────────────────────────</span>
<span class="pr">DebugPrint:</span> 0x3fa50104a63d: [JSArray]                  <span class="cm"># a</span>
  - map:      0x3fa50100bf51 &lt;Map[16](<span class="f-elem">PACKED_ELEMENTS</span>)&gt;
  - elements: <span class="f-map" data-f="fa">0x3fa50104a611</span> &lt;FixedArray[2]&gt;
  - length:   2
  - elements:
      0: <span class="f-o1" data-f="o1">0x3fa50104a5e9</span> &lt;JSArray[3]&gt;              <span class="cm">&lt;- o1</span>
      1: <span class="f-o2" data-f="o2">0x3fa50104a621</span> &lt;Object&gt;                  <span class="cm">&lt;- {}</span>
<span class="rule">──────────────────────────────────────────────</span>
<span class="pr">pwndbg&gt;</span> x/2gx <span class="f-map" data-f="fa">0x3fa50104a611</span> <span class="f-tag">- 1</span>              <span class="cm"># le FixedArray de a</span>
0x3fa50104a610:  00000002 000005dd   <span class="b f-o2" data-f="o2">0104a621</span> <span class="b f-o1" data-f="o1">0104a5e9</span>
                 <span class="cm">length   map        a[1]     a[0]</span>
</div>

<p class="term-cap">En vert, la même valeur à trois endroits : l'adresse de <code>o1</code>, la case <code>a[0]</code> dans <code>%DebugPrint</code>, et les 4 octets en mémoire. Little-endian : <code>a[0]</code> est la moitié de droite du qword.</p>

Ce qu'on lit :

- `a` est en **`PACKED_ELEMENTS`** : son backing store est un `FixedArray`, plus un `FixedDoubleArray` ;
- la case `a[0]` ne contient pas le tableau `o1`, elle contient **son adresse**, `0x3fa50104a5e9`, exactement celle que donne `%DebugPrint(o1)` ;
- en mémoire, cette adresse est compressée : **`0104a5e9`**, 4 octets. Avec la base de la cage `0x3fa500000000`, on retrouve `0x3fa50104a5e9`. Les deux cases tiennent dans un seul qword.

### Pourquoi c'est important en pwn

En JS, `a[0]` te rend **l'objet**, jamais son adresse. Le moteur la connaît, elle est écrite en clair dans le `FixedArray`, mais le langage ne l'expose pas.

Si un bug permet de **lire ces 4 octets comme un nombre** au lieu de les suivre comme un pointeur, on obtient l'adresse de n'importe quel objet qu'on a mis dans le tableau. C'est la primitive **`addrOf`** :

```
addrOf(o1)  ->  0x0104a5e9   (+ base de la cage = 0x3fa50104a5e9)
```

L'opération inverse existe aussi : **écrire** une adresse choisie dans une case d'un tableau d'objets, et V8 la traitera comme un objet. C'est **`fakeObj`**. Ces deux primitives sont la base de presque tous les exploits V8, et c'est là que le tableau de floats revient : c'est lui qui permet de lire et d'écrire ces octets bruts. On construit tout ça dans un prochain post.
