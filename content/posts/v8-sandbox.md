---
title: V8 - le sandbox et l'External Pointer Table
date: 2026-11-22
level: 3
tags: v8, sandbox, pwn, browser
excerpt: Partie 2. Jusqu'où porte le read/write de la partie 1 ? La cage de compression, le sandbox de 1 To, et les tables de pointeurs indirects (EPT/TPT) qui laissent un pointeur sortir sans le rendre forgeable. Avec de vrais dumps.
---

Partie 2. Dans [la partie 1](v8-intro.html), on a vu qu'un tableau de doubles donne, par case, **64 bits** qu'on écrit tels quels, et qu'un bug qui corrompt un `length` transforme ça en lecture/écriture de mots machine. Question logique : ces mots, ils portent **jusqu'où** ? Partout dans le process (libc, pile, code) ? Non. C'est tout l'objet du **sandbox V8**.

> Tous les dumps viennent de `d8` V8 15.7.0, lancé avec `--sandbox-testing` (expose une API de lecture mémoire). Les adresses changent à chaque run : la cage est rebasée (ASLR). Ce qui compte, ce sont les **positions relatives**.

## Une protection, c'est quoi

Une mitigation ne corrige pas le bug. Elle **retire une capacité** dont la chaîne d'exploit a besoin.

Le sandbox part d'un constat résigné : l'attaquant **a déjà** de la corruption mémoire dans le tas JS (exactement la primitive de la partie 1), et on ne sait pas l'en empêcher. Son but n'est donc pas de bloquer ça, mais de **confiner** : que ce read/write reste cantonné au tas de V8, et ne devienne **pas** un read/write arbitraire sur tout le process. En une phrase : *tu peux casser des objets JS, tu ne dois pas pouvoir toucher le reste du process.*

Tout le design qui suit découle de cette ligne.

## La cage (rappel de la partie 1)

La **pointer compression** stocke les pointeurs entre objets du tas sur **32 bits** : une moitié basse, additionnée à une base commune, la *cage*. Un objet ressemblait à ça en mémoire :

```
0x1f860104c415: [JSArrayBuffer]
 - map:      0x1f860101026d   (champ brut 0101026d)
 - elements: 0x1f86000007e5   (champ brut 000007e5)
```

La cage fait **4 Go** (`0x100000000`). Conséquence directe, et c'est la première brique de la protection : un champ pointeur ne fait que 32 bits, donc **quoi que tu y écrives, l'adresse reconstruite reste dans les 4 Go de la cage**. Impossible, en corrompant un champ compressé, de désigner une adresse arbitraire sur 64 bits.

## Le sandbox : 1 To autour de la cage

Problème : toutes les données ne tiennent pas dans la cage. Un `ArrayBuffer` peut être énorme, et son *backing store* (les octets réels) ne vit pas parmi les objets compressés. V8 réserve donc une région **beaucoup plus grande**, le **sandbox**, qui contient la cage **et** ces données :

<div class="term">
<span class="cm"># d8 --sandbox-testing --allow-natives-syntax</span>
<span class="f-map">cage   </span> : 0x1f8600000000 .. 0x1f8700000000   <span class="cm">(4 Go, pointeurs 32 bits)</span>
<span class="f-elem">sandbox</span> : 0x1f8600000000 .. 0x208600000000   <span class="cm">(1 To = 2^40 octets)</span>

ArrayBuffer.<span class="f-dbl">backing_store</span> = <span class="f-dbl">0x1f8800004000</span>   <span class="cm"># hors cage, dans le sandbox</span>
</div>

Le backing store (`0x1f8800004000`) est **au-dessus de la fin de cage** (`0x1f8700000000`) mais **dans le sandbox** (`< 0x208600000000`). Il est donc hors de portée d'un pointeur compressé 32 bits ; V8 le référence autrement.

![La cage dans le sandbox, les tables dehors](assets/v8-memmap.svg)

### Les pointeurs sandboxés

Le champ `backing_store`, lu en brut dans l'objet (qui, lui, est dans la cage), ne contient **pas** `0x1f8800004000`. Il contient ceci :

<div class="term">
champ <span class="f-dbl">backing_store</span> (octets bruts) = <span class="f-dbl">0x0200004000000000</span>
   <span class="f-tag">&gt;&gt; 24</span>                 = 0x0000000200004000
   + base 0x1f8600000000  = <span class="f-dbl">0x1f8800004000</span>   <span class="cm"># le vrai pointeur</span>
</div>

C'est un **pointeur sandboxé** : un offset depuis la base du sandbox, stocké décalé (ici de 24 bits, le sandbox faisant 2^40). La propriété clé : l'offset tient sur 40 bits, donc **l'adresse décodée retombe forcément dans le 1 To du sandbox**. Tu peux corrompre ce champ autant que tu veux, le pointeur résultant reste *dans* le sandbox. Même logique que la cage, en plus large.

Bilan intermédiaire : compression + pointeurs sandboxés garantissent qu'une corruption **dans** le sandbox reste **dans** le sandbox. Sauf que V8 a quand même besoin de pointer vers des choses **en dehors** : des objets C++, du code machine, des données de l'embarqueur. Et là un pointeur sandboxé ne sait même pas exprimer l'adresse.

## Sortir du sandbox : les tables de pointeurs indirects

Deux mauvaises options pour stocker un pointeur qui doit sortir du sandbox :

1. **Le mettre en clair** (64 bits inline dans l'objet) : un attaquant qui écrit dans le sandbox forge alors n'importe quel pointeur. Sandbox contourné, partie terminée.
2. **Un pointeur sandboxé** : incapable de désigner une adresse hors sandbox.

La solution de V8 : une **indirection par table**. Les vrais pointeurs sont rangés dans une **table située *hors* du sandbox**. L'objet, lui, ne stocke qu'un **handle** de 32 bits : un *index* dans la table (plus quelques bits de tag). Pour déréférencer, V8 va lire l'entrée correspondante.

Il y a deux tables jumelles, même mécanique :

- **External Pointer Table (EPT)** : pour les pointeurs **externes** bruts (objets C++, champs de l'embarqueur, getters d'`AccessorInfo`...).
- **Trusted Pointer Table (TPT)** : pour les objets V8 **de confiance** qui doivent être infalsifiables (`Code`, `BytecodeArray`, `RegExpData`...).

On peut le voir en vrai. Le champ `data` d'une `RegExp` pointe vers un `RegExpData` (trusted). Dans l'objet, ce n'est qu'un **handle** ; `%DebugPrint` le résout en une adresse qui est **hors sandbox** :

<div class="term">
<span class="pr">DebugPrint:</span> 0x1f860104c7a5: [JSRegExp]
 - <span class="f-len">data</span>: <span class="f-dbl">0x3afb01000421</span> &lt;Other heap object (ATOM_REG_EXP_DATA_TYPE)&gt;
<span class="rule">──────────────────────────────────────────────</span>
champ <span class="f-len">data</span> lu en brut dans l'objet (+12) = <span class="f-tag">0x00400c00</span>   <span class="cm"># handle 32 bits</span>
resolu par la table                     = <span class="f-dbl">0x3afb01000421</span>   <span class="cm"># HORS sandbox (0x3afb &gt; 0x2086)</span>
</div>

Le handle (`0x00400c00`) et le pointeur résolu (`0x3afb01000421`) n'ont **rien à voir** : le premier est un index, le second vit dans l'espace *trusted*, bien au-delà de la fin du sandbox (`0x208600000000`).

![Handle dans l'objet, pointeur réel dans la table hors sandbox](assets/v8-indirect-table.svg)

### Pourquoi ça protège

C'est tout l'intérêt de l'indirection :

- **Corrompre le handle** ne te donne pas un pointeur arbitraire. Au pire tu pointes vers **une autre entrée valide** de la table. Tu ne peux pas fabriquer `0x4141414141414141`.
- Chaque entrée porte un **type-tag**. En lisant, V8 vérifie que le tag correspond au type attendu : impossible d'utiliser une entrée EPT là où un pointeur de code est attendu (anti type-confusion).
- La table est **hors sandbox**, donc hors de portée de ton read/write sandboxé. Tu ne peux pas la réécrire directement.

Les trois encodages de pointeur, côte à côte :

![Compressé, sandboxé, externe](assets/v8-three-pointers.svg)

## Ce que ça change pour l'exploit

La primitive de la partie 1 (corrompre un `length`, lire/écrire des doubles) te donne un read/write arbitraire **dans le sandbox** : contrôle total du tas V8 et des données in-sandbox. Ce n'est **pas rien**, mais ce n'est plus un game over : tu ne touches ni le code, ni la libc, ni les pointeurs de retour, directement.

Pour aller plus loin, le travail devient « battre le sandbox » : abuser d'une entrée de table que tu peux atteindre, corrompre une structure de confiance, ou trouver un bug dans un composant hors sandbox. C'est un terrain à part entière.

## La suite

On sait maintenant où portent nos écritures, et pourquoi un pointeur vers l'extérieur passe par une table. Prochains posts : l'**architecture interne du moteur** (interpréteur, étages de JIT, GC), l'**architecture mémoire** fine des objets (Map, transitions, elements kinds), puis les **classes de bugs** du JIT, celles qui donnent la primitive de départ.
