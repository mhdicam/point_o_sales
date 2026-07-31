# brewsync 2.0 — Sprint Plan & Best Practices

> Panduan eksekusi buat ngedevelop brewsync 2.0 (modul POS + fondasi platform) secara rapi dan terukur.
> Turunan langsung dari `brewsync-pos-design.md`. Baca design doc dulu — dokumen ini soal **cara ngerjain**, bukan *apa*-nya.
> Stack: React + TypeScript + Zustand (frontend), Express + Prisma + PostgreSQL (backend).

Status: draft · 2026-07-31

---

## Daftar Isi
1. [Cara pakai dokumen ini](#1-cara-pakai-dokumen-ini)
2. [Best practices — aturan main tim](#2-best-practices--aturan-main-tim)
3. [Definition of Ready & Definition of Done](#3-definition-of-ready--definition-of-done)
4. [Standar teknis (non-negotiable)](#4-standar-teknis-non-negotiable)
5. [Roadmap sprint (overview)](#5-roadmap-sprint-overview)
6. [Sprint 0 — Setup & fondasi repo](#6-sprint-0--setup--fondasi-repo)
7. [Sprint 1 — Multi-tenant core + Auth](#7-sprint-1--multi-tenant-core--auth)
8. [Sprint 2 — RBAC + User + BusinessProfile](#8-sprint-2--rbac--user--businessprofile)
9. [Sprint 3 — Master produk](#9-sprint-3--master-produk)
10. [Sprint 4 — Order + bill pipeline](#10-sprint-4--order--bill-pipeline)
11. [Sprint 5 — Payment + split bill + shift](#11-sprint-5--payment--split-bill--shift)
12. [Sprint 6 — Inventory + recipe + purchasing](#12-sprint-6--inventory--recipe--purchasing)
13. [Sprint 7 — Meja, KDS, sales method](#13-sprint-7--meja-kds-sales-method)
14. [Sprint 8 — Reservasi + channel order (QR/online)](#14-sprint-8--reservasi--channel-order-qronline)
15. [Sprint 9 — Landing page + CMS + katalog](#15-sprint-9--landing-page--cms--katalog)
16. [Sprint 10 — Cetak, export, laporan](#16-sprint-10--cetak-export-laporan)
17. [Cross-cutting: testing, CI/CD, observability](#17-cross-cutting-testing-cicd-observability)
18. [Estimasi & prioritas](#18-estimasi--prioritas)

---

## 1. Cara pakai dokumen ini

- **Satu sprint = 2 minggu.** Angka sprint di sini urutan logis, bukan kalender mati — kalau tim kecil, satu "sprint" bisa makan lebih lama. Yang penting **urutan dependency**-nya dijaga.
- Tiap sprint punya: **Goal** (kenapa sprint ini ada), **Tasks** (pecahan teknis), **Acceptance criteria** (kapan dianggap selesai), dan **Definition of Done** global (§3) tetap berlaku di semua task.
- Task ditulis granular biar bisa langsung jadi tiket (Jira/Linear/GitHub Issues). Format ID: `S{sprint}-{nomor}`.
- **Jangan loncat sprint.** Fondasi (S0–S2) wajib beres sebelum fitur. Ini pelajaran dari brewsync lama: fitur numpuk di atas fondasi rapuh = utang teknis yang gak kebayar.

---

## 2. Best practices — aturan main tim

Ini yang bikin sprint "sesuai ekspektasi", bukan sekadar kelar. Aturan main disepakati sekali, dipegang terus.

### 2.1 Git & branching
- **Trunk-based ringan.** Branch pendek dari `main`, format `feat/S3-02-product-crud`, `fix/...`, `chore/...`. Umur branch ideal < 3 hari — makin lama makin sakit di-merge.
- **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`). Ini nyambung ke changelog & versioning otomatis nanti.
- **PR kecil.** Target < 400 baris perubahan. PR gede = review asal-asalan. Kalau task gede, pecah.
- `main` selalu deployable. Gak boleh push langsung ke `main` — semua lewat PR.

### 2.2 Code review
- **Minimal 1 approval** sebelum merge; 2 buat perubahan di layer fondasi (tenant scoping, pipeline duit, RLS).
- Reviewer ngecek: bener secara logika, ada test, gak nabrak standar §4, dan **gak ada `where: { tenantId }` manual** (auto-reject).
- Review dalam < 1 hari kerja. PR nyangkut lama = momentum ilang.

### 2.3 Ceremonies (seperlunya)
- **Sprint planning** di awal: pilih task, sepakati acceptance criteria, estimasi.
- **Daily async standup**: apa kemarin, apa hari ini, ada blocker gak. Cukup di chat, gak perlu meeting kalau tim kecil.
- **Review + retro** di akhir: demo yang jalan (bukan slide), lalu 1 hal yang diperbaiki sprint depan.
- **Backlog grooming** tengah sprint: rapiin tiket sprint berikutnya biar pas planning udah "ready".

### 2.4 Prinsip ngoding
- **Vertical slice.** Satu fitur diselesaikan tembus dari DB → API → UI → test, bukan "semua backend dulu baru semua frontend". Biar tiap sprint ada yang beneran kepakai.
- **Definition of Done ketat** (§3). "Selesai" = merge + test ijo + bisa didemo, bukan "di laptop gw jalan".
- **Jangan gold-plating.** Kerjain yang ada di acceptance criteria. Ide bagus di luar scope → masuk backlog, bukan diam-diam dikerjain.
- **Spike dulu kalau buta.** Hal yang belum jelas teknisnya (mis. payment gateway) → time-boxed spike (maks 1–2 hari) buat riset, hasilnya keputusan tertulis, baru bikin task beneran.

---

## 3. Definition of Ready & Definition of Done

### 3.1 Definition of Ready (boleh masuk sprint kalau…)
- [ ] Acceptance criteria jelas & bisa diuji.
- [ ] Dependency-nya udah selesai / gak ada yang ngeblok.
- [ ] Cukup detail teknis buat mulai (entitas/endpoint/komponen kesebut).
- [ ] Diestimasi tim (story point / T-shirt size).

### 3.2 Definition of Done (task dianggap kelar kalau…)
- [ ] Kode di-merge ke `main` lewat PR yang di-approve.
- [ ] **Test ada & ijo** — unit buat logika, integration buat endpoint kritikal. Yang nyentuh duit/stok/tenant-scoping **wajib** ada test.
- [ ] Lint & typecheck lolos (CI ijo). Gak ada `any` liar, gak ada `@ts-ignore` tanpa alasan.
- [ ] **Tenant-scoping via layer, bukan manual.** Gak ada `where: { tenantId }` di service.
- [ ] Feature toggle & permission dijaga **dua sisi** (FE sembunyiin, BE nolak) kalau relevan.
- [ ] Duit = integer minor unit, gak ada `float`.
- [ ] Responsive dicek di minimal 2 breakpoint (mobile + target device fitur itu).
- [ ] Bisa didemo di lingkungan staging/seed.
- [ ] Dokumentasi seperlunya keupdate (README modul / komentar keputusan penting).

---

## 4. Standar teknis (non-negotiable)

Ini penjabaran "Prinsip yang wajib dipegang" (design doc §11) jadi aturan konkret yang dicek di review.

1. **Tenant scoping di SATU layer.** Prisma Client Extension inject filter `tenantId` dari context (AsyncLocalStorage / request context) + Postgres RLS sebagai jaring pengaman. Service gak pernah nulis filter tenant manual. Ada test yang mastiin query tenant A gak bisa baca data tenant B.
2. **Uang = integer minor unit.** Tipe `BigInt`/`Int` di Prisma, helper `Money` di kode. Rounding cuma di pipeline bill (§6 design), sekali, disimpan sebagai `OrderCharge`.
3. **Ledger append-only.** Stok/kas/poin gak pernah di-`UPDATE`. Selalu insert movement; saldo = `SUM`. Gak ada kolom `stockOnHand` yang di-update.
4. **Event via Transactional Outbox.** Business write + `OutboxEvent` dalam satu transaksi DB. Consumer idempotent (pakai event `id`). Producer gak manggil consumer langsung.
5. **Feature toggle & permission dua sisi.** FE (`usePermission`/toggle hook) buat UX; BE (middleware `requirePermission` / guard toggle) buat keamanan. Yang cuma dijaga FE = bug.
6. **State machine eksplisit.** Order, PO, Reservation, Shift — transisi status divalidasi di satu tempat (gak boleh loncat status sembarangan). Transisi ilegal = error, bukan diam-diam diterima.
7. **Snapshot di titik yang bener.** Harga/nama item beku saat `SENT`; harga & qty PO beku saat `APPROVED`. Laporan historis gak berubah kalau master di-edit.

---

## 5. Roadmap sprint (overview)

| Sprint | Fokus | Ngebuka apa | Design ref |
|---|---|---|---|
| **S0** | Setup repo, tooling, CI, skema dasar | semua kerja berikutnya | §11 |
| **S1** | Multi-tenant core + Auth + Outbox skeleton | isolasi tenant, login | §1, §11 |
| **S2** | RBAC dinamis + User + BusinessProfile | hak akses, feature toggle | §2, §12, §13 |
| **S3** | Master produk (Category, Unit, Product, Variant, Modifier, PriceList) | katalog jualan | §3 |
| **S4** | Order + bill pipeline | jantung POS: nyusun order & hitung tagihan | §5, §6 |
| **S5** | Payment + split bill + Shift/kas | terima bayar, tutup kas | §7, §14 |
| **S6** | Inventory + recipe + purchasing | stok, HPP, PO/supplier | §4 |
| **S7** | Meja, KDS, sales method | operasional lantai F&B | §5.3–5.6 |
| **S8** | Reservasi + channel order (QR/online) | booking + order self-service | §15, §16 |
| **S9** | Landing page + CMS + katalog motion | etalase publik + take-order | §17 |
| **S10** | Cetak, export PDF/Excel, laporan | struk, laporan, rekap | §8, §18 |

> **MVP jualan paling cepat** = S0–S5 + S7 (POS F&B dine-in yang bisa transaksi & tutup kas). S6 & S10 nyusul buat operasional penuh. S8–S9 fitur diferensiasi.

---

## 6. Sprint 0 — Setup & fondasi repo

**Goal:** infrastruktur kerja siap, satu perintah buat jalanin semua, CI ijo dari commit pertama. Gak ada fitur bisnis — tapi ini yang bikin sprint berikutnya kenceng.

| ID | Task | Detail teknis |
|---|---|---|
| S0-01 | Inisialisasi monorepo | pnpm workspaces / Turborepo. Paket: `apps/api` (Express), `apps/pos` (React kasir), `apps/landing` (React publik), `packages/shared` (tipe, Money helper, enum permission), `packages/db` (Prisma schema + client). |
| S0-02 | Tooling kualitas kode | TypeScript strict mode, ESLint + Prettier, Husky pre-commit (lint-staged), Conventional Commits (commitlint). |
| S0-03 | Setup PostgreSQL + Prisma | Docker Compose buat Postgres lokal. Prisma init. Migrasi baseline kosong. Script seed skeleton. |
| S0-04 | CI pipeline | GitHub Actions: install → typecheck → lint → test → build. Wajib ijo sebelum merge (branch protection). |
| S0-05 | Struktur folder & konvensi | Sepakati layout (routes/controllers/services/repositories di API; features-based di FE). Tulis di `CONTRIBUTING.md`. |
| S0-06 | Env & config management | `.env` + validasi env (zod) saat boot. Config per environment (dev/staging/prod). |
| S0-07 | Health check + logging dasar | Endpoint `/health`, structured logging (pino). |

**Acceptance criteria:**
- `pnpm install && pnpm dev` jalanin API + FE + DB dalam sekali perintah.
- CI ijo di PR contoh (mis. nambah endpoint `/health`).
- Commit yang ngelanggar Conventional Commits ketolak lokal.

---

## 7. Sprint 1 — Multi-tenant core + Auth

**Goal:** isolasi tenant beneran jalan & teruji, user bisa login. Ini fondasi keamanan — salah di sini, semua modul bocor.

| ID | Task | Detail teknis |
|---|---|---|
| S1-01 | Skema Tenant + Outlet | Prisma model `Tenant`, `Outlet`. Relasi + index dasar. |
| S1-02 | Request context (tenant) | Middleware ekstrak `tenantId` dari JWT/session → simpan di AsyncLocalStorage. Semua request bawa konteks tenant. |
| S1-03 | **Prisma Client Extension tenant-scoping** | Extension auto-inject `where tenantId` dari context di semua query model ber-tenant. Ini implementasi standar §4.1. |
| S1-04 | **Postgres Row-Level Security** | Enable RLS di tabel ber-tenant, policy pakai session var `app.current_tenant`. Jaring pengaman kalau extension bocor. |
| S1-05 | Auth: register/login | `User` (email + passwordHash argon2), JWT access + refresh token. Endpoint login/refresh/logout. |
| S1-06 | Outbox skeleton | Model `OutboxEvent`, helper `emitEvent(tx, type, payload)` yang nulis dalam transaksi, worker in-process yang baca & dispatch (idempotent). |
| S1-07 | **Test isolasi tenant** | Test: tenant A query, gak keliatan data tenant B — via extension DAN via RLS (dua lapis). Ini test paling penting di sprint ini. |

**Acceptance criteria:**
- User bisa register + login, dapet token.
- Query tanpa nulis `where tenantId` otomatis ke-scope; test lintas-tenant merah kalau scoping dimatiin (bukti guard-nya nyata).
- `emitEvent` nulis outbox + worker dispatch sekali walau di-retry.

---

## 8. Sprint 2 — RBAC + User + BusinessProfile

**Goal:** hak akses dinamis & feature toggle jalan dua sisi. Setelah ini, tiap fitur bisa disandarin ke permission + toggle.

| ID | Task | Detail teknis |
|---|---|---|
| S2-01 | Katalog Permission | Enum/konstanta permission di `packages/shared` (`order.void`, `purchase.approve`, dst). Seed ke tabel `Permission`. |
| S2-02 | Role + RolePermission | Model `Role` (isSystem flag), `RolePermission`. Seed preset role per tenant saat provisioning. CRUD role custom. |
| S2-03 | UserRole + scope outlet | Model `UserRole` (userId, roleId, outletId?). Resolver "permission efektif" (union role user di outlet konteks), di-cache per sesi. |
| S2-04 | **Middleware `requirePermission`** | Guard endpoint di BE. 403 kalau permission gak ada. Test: role tanpa izin ketolak. |
| S2-05 | Hook `usePermission` (FE) | Sembunyiin/disable tombol di FE. Murni UX. |
| S2-06 | TenantMembership + PIN kasir | Model `TenantMembership` (pinHash, employeeCode). Login cepat via PIN di device POS. |
| S2-07 | BusinessProfile + feature toggle | Model `BusinessProfile` (preset + features JSON). Guard toggle dua sisi: helper `requireFeature` (BE) + `useFeature` (FE). |
| S2-08 | Onboarding tenant | Flow: bikin tenant → provision preset role + BusinessProfile default → invite user pertama (owner). |

**Acceptance criteria:**
- Tenant bisa bikin role custom, centang permission, assign ke user per outlet.
- Endpoint sensitif nolak user tanpa permission (test).
- Toggle off = UI ilang **dan** endpoint nolak (test dua sisi).
- User bisa login via PIN di konteks tenant.

---

## 9. Sprint 3 — Master produk

**Goal:** katalog jualan lengkap & fleksibel lintas vertical. Bisa dites lewat CRUD + seed per preset (FNB/RETAIL/SERVICE).

| ID | Task | Detail teknis |
|---|---|---|
| S3-01 | Category (nested) | Self-ref `parentId`. Simpan default: KDS route, tarif pajak, report group. |
| S3-02 | Unit / UoM + konversi | Sell-unit vs stock-unit, faktor konversi dalam satu dimensi. |
| S3-03 | Product + ProductVariant | Product (fulfillmentType) → Variant (SKU, basePrice, barcode). Tiap product ≥1 variant default. |
| S3-04 | Modifier + ModifierGroup | priceDelta + recipeDelta. Relasi many-to-many Product ↔ ModifierGroup. |
| S3-05 | PriceList + PriceListItem | Override harga per outlet & sales method. Fallback ke basePrice. |
| S3-06 | Seed per vertical | Seed data contoh FNB, RETAIL, SERVICE buat demo & test. |
| S3-07 | UI master produk (admin) | CRUD responsive, list ter-virtualisasi (menu bisa ratusan item). |

**Acceptance criteria:**
- Bisa bikin produk multi-varian dengan modifier & harga per konteks.
- Resolusi harga: (outlet+salesMethod) → PriceList → fallback basePrice, teruji.
- Seed 3 vertical jalan, kelihatan bedanya di UI.

---

## 10. Sprint 4 — Order + bill pipeline

**Goal:** jantung POS. Nyusun order sampai tagihan final yang bener. Selesaikan **sebelum** sentuh pembayaran.

| ID | Task | Detail teknis |
|---|---|---|
| S4-01 | Order + OrderItem | Model + relasi. Tambah item, ubah qty, hapus (saat OPEN). |
| S4-02 | **Order state machine** | OPEN→SENT→SERVED→BILLED→PAID→CLOSED + VOID. Transisi divalidasi satu tempat (§4 standar #6). |
| S4-03 | Snapshot harga saat SENT | Beku `priceSnapshot`, `nameSnapshot`, modifier delta. |
| S4-04 | **Bill pipeline (§6 design)** | Urutan fixed: subtotal → diskon (item→order) → service charge → pajak → rounding (sekali) → total → gratuity. Tiap komponen jadi `OrderCharge`. |
| S4-05 | Inclusive vs exclusive tax | Config per outlet/sales method. Extract net kalau inclusive. |
| S4-06 | Diskon item & order | Persen/nominal, jadi `OrderCharge kind=DISCOUNT` (amount negatif). |
| S4-07 | **Test pipeline** | Test angka: kombinasi diskon+SC+pajak inclusive/exclusive, rounding sekali. Ini test krusial — bug halus duit ada di sini. |
| S4-08 | UI order (kasir) | Grid produk + panel order, responsive tablet. Tambah item cepat, lihat running total. |

**Acceptance criteria:**
- Order jalan tembus state machine; transisi ilegal ketolak.
- Pipeline ngeluarin angka bener di semua kombinasi (test), rounding tepat sekali.
- Tiap charge kelihatan sebagai baris `OrderCharge` (transparan, bukan cuma total).

---

## 11. Sprint 5 — Payment + split bill + shift

**Goal:** terima pembayaran (termasuk split), buka/tutup kas dengan rekonsiliasi. Setelah ini POS udah bisa transaksi end-to-end.

| ID | Task | Detail teknis |
|---|---|---|
| S5-01 | Bill + Payment | Order→Bill→Payment. Bill lunas saat `SUM(payment) >= total` → order PAID. |
| S5-02 | PaymentMethod data-driven | Flag `opensCashDrawer`, `needsRefNo`, `countsAsCash`. |
| S5-03 | Split payment | Banyak tender / satu bill. Kembalian di tender cash terakhir. |
| S5-04 | Split bill | By-item & split-even. **Invariant `SUM(bill.total) === total order`** dijaga + diuji. |
| S5-05 | Refund | Payment negatif + alasan + otorisasi → event `RefundIssued`. Append-only. |
| S5-06 | Shift + CashMovement | Buka shift (`openingFloat`), gerakan kas append-only, tutup shift + `cashVariance`. |
| S5-07 | Event SaleCompleted / ShiftClosed | Emit ke outbox saat PAID & tutup shift (buat Accounting nanti). |
| S5-08 | UI bayar + shift | Layar pembayaran (split), buka/tutup shift, tampil selisih jelas. |

**Acceptance criteria:**
- Bisa bayar split (multi-tender & multi-bill); invariant split bill teruji.
- Refund kecatat append-only + emit event.
- Tutup shift ngitung expected vs counted, selisih tampil + minta alasan kalau lewat toleransi.

---

## 12. Sprint 6 — Inventory + recipe + purchasing

**Goal:** stok akurat lewat ledger, HPP otomatis, alur beli (PO/supplier) nyambung ke stok.

| ID | Task | Detail teknis |
|---|---|---|
| S6-01 | StockMovement (append-only) | Signed qty base unit, tipe enum. On-hand = `SUM`. Gak ada kolom on-hand. |
| S6-02 | Pengurangan stok saat jual | STOCKED langsung; MADE_TO_ORDER telusuri resep. Titik potong (SENT/PAID) konfigurable. |
| S6-03 | Recipe / BOM rekursif | `RecipeItem.componentType` INGREDIENT/PRODUCT. Sub-resep. Toggle `features.recipe`. |
| S6-04 | Valuasi moving-average + COGS | `costPerUnit` per movement → nilai persediaan + event COGS. |
| S6-05 | Supplier | Master level tenant: kontak, NPWP, `paymentTermDays`. |
| S6-06 | PurchaseOrder + state machine | DRAFT→SUBMITTED→APPROVED→RECEIVING→RECEIVED→CLOSED + CANCELLED. Snapshot harga saat APPROVED. |
| S6-07 | Goods receipt | Terima barang → `StockMovement type=PURCHASE` + update `qtyReceived` (partial receipt). |
| S6-08 | Event GoodsReceived | Emit buat Accounting (persediaan + utang). |
| S6-09 | UI inventory + PO | Stock opname (ADJUSTMENT), buat/approve/terima PO. |

**Acceptance criteria:**
- On-hand selalu = SUM movement; stock opname bikin ADJUSTMENT, bukan overwrite.
- Jual item ber-resep ngurangin ingredient dasar (test rantai resep).
- Terima PO nambah stok + nyuplai moving-average; partial receipt jalan.

---

## 13. Sprint 7 — Meja, KDS, sales method

**Goal:** operasional lantai F&B — denah meja, kitchen display, sales method nyetir alur.

| ID | Task | Detail teknis |
|---|---|---|
| S7-01 | SalesMethod | dine-in/takeaway/delivery. Nyetir price list, pajak, SC, route KDS. |
| S7-02 | Table + Area | Status EMPTY/OCCUPIED/RESERVED/DIRTY. Satu meja = satu order aktif. Toggle `features.tables`. |
| S7-03 | Transfer / merge / move item | Pindah order antar meja, gabung, pindah sebagian item. |
| S7-04 | Station + routing KDS | Mapping Category→Station. Item SENT muncul di station. Toggle `features.kds`. |
| S7-05 | KDS board (realtime) | Lane QUEUED→PREPARING→READY→SERVED. Update realtime (WebSocket/SSE — putuskan via spike). |
| S7-06 | UI denah meja | Responsive tablet, status meja jelas, tap buat buka order. |
| S7-07 | UI KDS | Layout layar besar landscape, kolom per station, kebaca dari jauh. |

**Acceptance criteria:**
- Order kebuka dari meja; transfer/merge jalan tanpa ngerusak angka.
- Item SENT nongol di station yang bener realtime.
- Board KDS update tanpa refresh manual.

---

## 14. Sprint 8 — Reservasi + channel order (QR/online)

**Goal:** booking + order self-service dari customer, tetap nurun ke Order yang sama.

| ID | Task | Detail teknis |
|---|---|---|
| S8-01 | Reservation + state machine | REQUESTED→CONFIRMED→SEATED→COMPLETED + NO_SHOW/CANCELLED. Toggle `features.reservation`. |
| S8-02 | Anti double-book | Validasi overlap meja/staff di BE. |
| S8-03 | Deposit reservasi | Lewat jalur `Payment`; potong dari bill saat seated. |
| S8-04 | Seated → Order | Bikin Order + set meja OCCUPIED (F&B) / board slot (jasa). |
| S8-05 | `Order.channel` + qrToken | Field channel (STAFF/QR_TABLE/ONLINE). `Table.qrToken` acak. |
| S8-06 | QR order flow | Scan token → menu meja spesifik → order QR_TABLE. Opsi auto-accept / staff-approve. |
| S8-07 | Online order flow | Checkout dari landing → channel ONLINE, sales method pickup/delivery, window expiry buat unpaid. |
| S8-08 | UI order customer | HP portrait, single-column, jempol-friendly, checkout mulus. |

**Acceptance criteria:**
- Reservasi gak bisa double-book (test overlap).
- Scan QR meja A cuma bisa order buat meja A (token acak, teruji gak bisa ditebak).
- Order QR/online masuk pipeline + KDS sama seperti order staff.

---

## 15. Sprint 9 — Landing page + CMS + katalog motion

**Goal:** etalase publik yang bisa jadi katalog atau take-order, dikelola admin, dengan motion yang mulus & responsive.

| ID | Task | Detail teknis |
|---|---|---|
| S9-01 | LandingPage + LandingSection | Section-based (HERO/CATALOG/ABOUT/dst). Toggle `features.landingPage`. |
| S9-02 | CMS admin | Drag-urut section, edit konten per blok, publish flow DRAFT→PUBLISHED. Permission `landing.manage`. |
| S9-03 | CATALOG section dari master | Narik produk live dari master (§3), pilih kategori/produk yang dipajang. |
| S9-04 | Mode katalog vs order | `orderingEnabled` (mirror `onlineOrder`): tombol checkout muncul/ilang. |
| S9-05 | Motion katalog | Scroll reveal, hover lift, hero paralaks, skeleton shimmer. Cuma `transform`/`opacity`. Framer Motion + varian shared. |
| S9-06 | Perf & a11y | Lazy-load + `srcset`, target 60fps HP menengah, hormati `prefers-reduced-motion`. |
| S9-07 | SEO dasar | Meta title/description, Open Graph, sitemap. |

**Acceptance criteria:**
- Admin bisa susun landing tanpa developer; draft gak bocor ke publik.
- Toggle order OFF = katalog murni; ON = bisa checkout.
- Lighthouse: performance & accessibility hijau; reduced-motion dihormati.

---

## 16. Sprint 10 — Cetak, export, laporan

**Goal:** struk/dokumen tercetak, laporan bisa diekspor PDF/Excel, semua konsisten dari data yang sama.

| ID | Task | Detail teknis |
|---|---|---|
| S10-01 | Renderer struk thermal | 58/80mm, monospace, dari Bill+OrderItem+OrderCharge+Payment. Reprint kecatat. |
| S10-02 | Template konfigurable | Header/footer per tenant (logo, NPWP, ucapan). Data-driven. |
| S10-03 | Tiket dapur & label | Print per station (kalau pakai printer), label takeaway. |
| S10-04 | Cetak PO & bukti reservasi | A4/PDF. |
| S10-05 | Laporan penjualan | Per outlet/periode/kategori/produk. Agregasi dari Order/OrderCharge. |
| S10-06 | Laporan shift X/Z | Dari Shift + CashMovement + Payment. |
| S10-07 | Export PDF | Laporan & dokumen (pakai skill `pdf`). Header/footer brand. |
| S10-08 | Export Excel/CSV | Rekap transaksi, mutasi stok, PO, pajak (pakai skill `xlsx`). Tipe kolom bener. |
| S10-09 | Guard permission export | `report.view` / `report.export`. Endpoint nolak tanpa izin. |

**Acceptance criteria:**
- Struk cetak = angka di layar = angka laporan (konsisten by design).
- Export PDF & Excel dari periode sama gak beda angka.
- Laporan finansial kebatasi permission (test).

---

## 17. Cross-cutting: testing, CI/CD, observability

Ini jalan **paralel** di semua sprint, bukan sprint tersendiri.

### 17.1 Testing (piramida)
- **Unit** — logika murni: pipeline bill, konversi unit, resolver permission, valuasi stok. Cepat & banyak.
- **Integration** — endpoint + DB (pakai test DB / testcontainers). Wajib buat: tenant isolation, pipeline duit, split bill invariant, state machine, RLS.
- **E2E (secukupnya)** — happy path kritikal: order → bayar → tutup shift. Pakai Playwright. Jangan kebanyakan; mahal & rapuh.
- **Aturan:** tiap bug yang ketemu → tulis test dulu yang mereproduksi, baru fix (regression guard).

### 17.2 CI/CD
- CI tiap PR: typecheck → lint → unit → integration → build. Merge diblok kalau merah.
- Migrasi DB otomatis di pipeline staging. **Migrasi selalu maju & aman** (gak drop data sembarangan; kolom baru nullable/berdefault).
- Deploy staging otomatis dari `main`; production manual approval.
- Seed data demo di staging biar bisa didemo tiap akhir sprint.

### 17.3 Observability
- Structured logging (pino) dengan `tenantId`/`requestId` di tiap log.
- Error tracking (Sentry atau sejenis).
- Monitor outbox: alert kalau ada event `dispatchedAt` null kelamaan (event nyangkut).
- Metrik dasar: latensi endpoint kritikal, error rate.

### 17.4 Keamanan (jalan terus)
- Secret di env/secret manager, gak pernah di repo.
- Rate limit di endpoint auth & publik (QR/online order).
- Validasi input (zod) di semua endpoint.
- Audit trail (createdBy/approvedBy) buat aksi sensitif — udah di model, pastiin keisi.

---

## 18. Estimasi & prioritas

### 18.1 Cara estimasi
- **Story point (Fibonacci: 1,2,3,5,8,13).** > 13 = kegedean, pecah dulu.
- Estimasi **relatif**, bukan jam. Kalibrasi tiap retro pakai velocity nyata.
- Task fondasi (S0–S2) sering "kecil di UI tapi berat di risiko" — hargai risikonya, jangan under-estimate.

### 18.2 Prioritas (MoSCoW buat MVP jualan)
- **Must** — S0, S1, S2, S3, S4, S5, S7 (POS F&B dine-in transaksi + tutup kas).
- **Should** — S6 (inventory/HPP), S10 (struk & laporan dasar).
- **Could** — S8 (reservasi/QR/online), S9 (landing/CMS).
- **Won't (belum)** — modul HR & Accounting penuh, billing/subscription SaaS, KDS multi-printer lanjutan. Ada di doc terpisah.

### 18.3 Rambu biar sesuai ekspektasi
- **Demo tiap akhir sprint pakai yang jalan**, bukan slide. Kalau gak bisa didemo, berarti belum done.
- **Jangan mulai sprint fitur kalau fondasi (S0–S2) belum ijo.** Ini pelajaran utama dari brewsync lama.
- **Vertical slice tiap sprint** — selalu ada sesuatu yang beneran kepakai user di akhir sprint.
- **Utang teknis dicatat**, bukan didiemin. Alokasikan ~10–15% tiap sprint buat bayar utang & refactor.
