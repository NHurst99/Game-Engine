# Goal
Introduce a centralized, scalable string management + localization system for a Node-based game platform with support for modular game packs.

---

# High-Level Design

Implement a **StringManager service** responsible for:
- Loading string resources (core + packs)
- Resolving keys at runtime
- Handling localization + fallback
- Interpolating variables

All user-facing text must go through this system.

---

# Suggested Architecture

## 1. Resource Structure

Use JSON as the source of truth.

Core:
```

/core/locales/en.json
/core/locales/es.json

```

Game packs:
```

/packs/<packId>/locales/en.json
/packs/<packId>/locales/es.json

```

---

## 2. Key Format (Required)

All keys must be **dot-based and namespaced**.

Examples:
```

ui.start_button
ui.exit_button
enemy.goblin.name
enemy.goblin.attack

```

Runtime access format:
```

<namespace>:<key>

```

Examples:
```

core:ui.start_button
pack1:enemy.goblin.name

```

---

## 3. StringManager Responsibilities

### State
- `currentLanguage` (e.g. "en")
- `defaultLanguage` (fallback, e.g. "en")
- `coreLocales`
- `packLocales` (keyed by packId)

---

### Public API

```

t(key: string, vars?: Record<string, any>): string
registerCore(locales)
registerPack(packId, locales)
setLanguage(lang)

```

---

### Resolution Logic

When calling:
```

t("pack1:enemy.goblin.attack")

```

Resolve in this order:

1. pack1[activeLang]
2. pack1[defaultLang]
3. core[activeLang]
4. core[defaultLang]

If still missing:
- return the key itself (for debugging)

---

### Interpolation

Support simple variable replacement:

Input:
```

"enemy.attack": "Deals {damage} damage"

```

Usage:
```

t("pack1:enemy.attack", { damage: 5 })

```

---

## 4. Pack Registration

At runtime, each pack must register its locales:

```

registerPack("pack1", {
en: {...},
es: {...}
})

```

Core registers similarly:
```

registerCore({
en: {...},
es: {...}
})

```

---

# Enforcement Rules (Critical)

## 1. No Raw Strings
All user-facing strings must go through:
```

t(...)

```

---

## 2. Immutable Keys
Once a key is introduced, it must never be renamed or removed without migration.

---

## 3. Namespace Isolation
- `core:*` is reserved
- Packs must only use their own namespace (`packId:*`)
- No cross-pack string access

---

## 4. Required Default Locale
Each pack MUST include at least:
```

locales/en.json

```

---

## 5. Graceful Fallback
Missing translations must never crash the system.

---

# Suggested Enhancements (Optional but Recommended)

## 1. Validation Script
Create a tool that:
- Compares all locale files
- Detects missing keys per language
- Detects duplicate or conflicting keys
- Optionally flags unused keys

---

## 2. Debug Mode
- Log missing keys
- Highlight fallback usage

---

## 3. Metadata Support (Future)
Allow structured entries:
```

"enemy.goblin.name": {
"text": "Goblin",
"description": "Enemy display name"
}

```

---

# Implementation Strategy (Step-by-Step)

1. Implement `StringManager` as a standalone module/service
2. Load core locale files into manager
3. Add pack registration hook during pack load
4. Replace existing hardcoded strings with `t(...)`
5. Enforce namespace + key format
6. Add fallback + interpolation logic
7. (Optional) Add validation tooling

---

# Key Principle

Centralize ALL string resolution logic in one place.

Do NOT:
- Access JSON directly throughout the codebase
- Duplicate localization logic
- Allow packs to bypass the system

---

# End State

- All strings externalized
- Localization-ready
- Pack-safe and scalable
- Minimal runtime complexity, maximum control
