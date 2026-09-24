# XYX — PRD Monad Testnet

**Versi:** 3.2 — target MVP end-to-end di atas alur kanonis XYXDeliveryProtocol
**Status:** acuan produk dan kriteria penerimaan
**Lingkungan:** Monad Testnet saja (chain ID 10143)

Audit kode, keputusan produk/infra, dan backlog rinci ada di [XYX_MONAD_BLUEPRINT.md](XYX_MONAD_BLUEPRINT.md). Hasil pengecekan lokal terbaru tercatat pada bagian 12 dokumen tersebut; target rancangan tidak berarti sudah terimplementasi.

---

## 1. Produk dan masalah

XYX adalah lapisan pembayaran bersyarat untuk pekerjaan agen. Buyer mengunci hadiah dalam escrow di `XYXDeliveryProtocol`. Provider mengerjakan instruksi yang disepakati. Attestor — bukan evaluator eksternal — memeriksa bukti dan menandatangani verdict EIP-712 yang diikat ke assertion passkey P256 melalui `MonadP256Verifier`. Kontrak membayar provider jika syarat terpenuhi, atau mengembalikan hadiah kepada buyer jika hasil ditolak atau job kedaluwarsa.

Masalah yang dituju: hash transaksi atau klaim agen bahwa tugas selesai tidak membuktikan hasilnya cocok dengan pesanan. Pembayaran di muka berisiko bagi buyer; pembayaran setelah kerja berisiko bagi provider. XYX harus mengikat instruksi, bukti, keputusan, dan perpindahan dana pada satu job yang bisa diaudit.

**Kasus pertama:** buyer memberi provider tugas mengirim 0,01 USDC pada Monad Testnet dari alamat provider ke recipient yang ditetapkan. Buyer mengunci hadiah 0,02 USDC. Nominal ini hanya parameter demo, bukan harga produk. Tugas ini dipilih karena hasilnya dapat diperiksa melalui transaksi dan event ERC-20; P0 belum menilai kualitas pekerjaan agen yang subjektif.

**Janji P0:** jika bukti yang tersedia cocok dengan syarat job, hadiah dibayar; jika bukti lengkap menunjukkan mismatch, hadiah di-refund; jika job tidak selesai saat expiry, refund dapat diklaim. Kontrak tidak membaca IPFS atau receipt secara langsung. Keputusan attestor tetap asumsi kepercayaan, dan evidence harus memungkinkan audit independen.

**Target produk adalah MVP end-to-end, bukan berhenti pada demo P0.** P0 membuktikan lifecycle dan tiga hasil melalui transaksi Testnet yang dapat diaudit; itu adalah gate teknis, bukan rilis produk selesai. MVP menambahkan alur yang dapat dijalankan buyer, provider, dan attestor melalui aplikasi/runner dengan wallet dan passkey mereka sendiri, tanpa mengedit JSON atau menjalankan CLI operator untuk langkah normal. `/demo` tetap menjadi tampilan audit read-only. Target ini belum diimplementasikan dan tidak boleh diklaim selesai dari gate lokal atau tiga run yang dijalankan manual.

**Extension Jev (pasca-P0, opsional):** XYX dapat menampilkan penilaian kesiapan evidence berbasis Jev sebelum attestor mengambil keputusan. Jev adalah pemberi rekomendasi off-chain; ia bukan attestor, oracle, signer, atau pihak yang berhak atas escrow. Extension ini tidak mengubah kontrak, lifecycle job, kriteria acceptance P0, atau bukti Testnet yang diperlukan untuk menyatakan settlement valid.

## 2. Pengguna, peran, dan hak

| Peran | Tindakan | Kepentingan |
| --- | --- | --- |
| Buyer | Menentukan tugas, membuat job, menyetujui allowance, mendanai escrow | Hasil sesuai instruksi atau hadiah kembali |
| Provider | Menerima attestor, mengirim USDC, menyerahkan delivery commitment | Dibayar jika tugas valid |
| Attestor | Menjalankan verifikasi, mendaftarkan passkey, memanggil `resolveJob` dengan verdict EIP-712 + assertion passkey | Keputusan yang dapat dipertanggungjawabkan |
| Relayer | Membayar gas (opsional) untuk transaksi permissionless | Tidak dapat mengubah verdict |
| Penonton/juri | Membaca UI, IPFS, dan explorer | Dapat menguji klaim demo tanpa kunci privat |

Buyer, provider, dan attestor wajib memakai tiga alamat berbeda; `proposeJob` menolak buyer yang sekaligus menjadi provider atau attestor. Relayer adalah peran non-kontrak: ia hanya dapat membayar gas, bukan memegang hak on-chain. Recipient dapat merupakan alamat tambahan. Aplikasi XYX tidak menerima atau menyimpan private key pengguna di server, bundle browser, local storage, Git, IPFS, log publik, atau file run; wallet pengguna atau signer integrator tetap mengelola kuncinya sendiri.

**Catatan kontrak (diverifikasi ke sumber):** `XYXDeliveryProtocol` tidak memiliki admin, owner, pauser, role management, atau pause/unpause. Tidak ada `AccessControl`/`Pausable` dan tidak ada konstruktor dengan argumen role. Otoritas per job dibatasi oleh pemanggil: buyer membuat job, mendanai job, dan dapat membatalkan proposal; provider menerima job dan menyerahkan delivery; attestor yang dipilih memanggil `resolveJob`; sedangkan `claimExpiryRefund` permissionless setelah expiry. Konsekuensinya: tidak ada mekanisme kontrak untuk "mencabut otoritas attestor" atau "menghentikan verdict baru"; pemilihan attestor berbeda hanya berlaku pada job baru. Kebijakan rotasi operasional saat insiden masih merupakan keputusan produk, bukan fitur kontrak yang sudah diimplementasikan.

## 3. Tujuan, ukuran sukses, dan batas P0

### Tujuan

1. Instruksi yang disetujui buyer tidak berubah diam-diam setelah job dibuat.
2. Hadiah benar-benar berada di escrow sebelum provider bekerja.
3. Pemeriksaan transfer mencakup chain, token, pengirim, recipient, jumlah, status transaksi, dan job.
4. Job memiliki satu hasil final: `Completed`, `Rejected`, `Expired`, atau `Cancelled`, dengan satu perpindahan hadiah yang benar. `Cancelled` tercapai sebelum dana masuk dan tidak memindahkan hadiah.
5. Orang lain dapat menelusuri job, spesifikasi, evidence, verdict, dan settlement.

### Ukuran penerimaan demo

- Tiga job testnet **berbeda** menghasilkan sukses, penolakan karena transfer salah, dan refund expiry.
- Masing-masing memiliki receipt, status final on-chain, serta bukti perpindahan USDC yang dapat dibuka publik.
- Halaman `/demo` jujur menampilkan kosong atau `UNVERIFIED` sampai chain dan storage terbaca. Fixture lokal tidak pernah disebut live.
- Juri dapat memeriksa data tanpa menjalankan wallet operator.

### Ukuran penerimaan MVP end-to-end

- Buyer menghubungkan wallet pada chain yang benar, menyusun syarat tervalidasi, membuat job, menyetujui allowance bila diperlukan, dan mendanai escrow melalui transaksi nyata. UI baru menampilkan job/funding setelah receipt dan state yang sesuai teramati; tidak ada job ID atau finality buatan.
- Provider yang dipilih menerima job, membaca syarat dan funding yang sudah final, menjalankan transfer USDC tugas dengan signer miliknya, lalu mengirim `deliveryCommitment`. Jalur provider dapat memakai runner dengan signer yang disuplai integrator, tetapi pengguna tidak perlu mengedit manifest/JSON atau menjalankan CLI operator untuk menyelesaikan job normal.
- Attestor yang dipilih menghubungkan alamat yang sama dengan `job.attestor`, mendaftarkan credential passkey nyata, meninjau evidence yang sudah diverifikasi, lalu memberi assertion WebAuthn/P256 dan mengirim `resolveJob` dari alamat tersebut. Tidak ada relayer independen yang menggantikan `msg.sender` attestor.
- COMPLETE dan REJECT membuktikan perpindahan escrow yang benar; EXPIRED dapat diklaim dari produk tanpa attestor, worker, atau IPFS. Semua operasi memiliki state pending, gagal, ambigu, dan finalized yang berasal dari observasi nyata; retry tidak menggandakan transfer atau settlement.
- Tiga skenario tersebut berhasil dari jalur produk terintegrasi di Monad Testnet dan dapat diaudit publik melalui manifest, evidence, dua RPC, serta `/demo`. Run operator P0 yang tidak melewati jalur produk tidak dapat dipakai sebagai bukti bahwa MVP end-to-end sudah berjalan.
- Jev Evidence Assessment tetap opsional dan advisory. Ketiadaannya tidak menghalangi alur MVP; bila ditampilkan, status `AVAILABLE` hanya berasal dari respons TypeSafe nyata yang tervalidasi.

### Batas

Hanya Monad Testnet dan satu jenis tugas payout USDC. Tidak ada marketplace terbuka, banyak token, fee, hooks, upgrade proxy, dispute manusia, HTTP outcome, x402, subgraph, registri identitas proprietary, reputasi, atau deployment mainnet pada P0. Provider diidentifikasi dari alamat penanda tangan transaksi. ERC-8004 dapat diteliti kemudian setelah kebutuhan dan deployment Monad yang dipilih diverifikasi. Implementasi escrow P0 minimal, bukan kontrak referensi upgradeable ERC-8183; lihat [draft ERC-8183](https://eips.ethereum.org/EIPS/eip-8183).

MVP end-to-end tetap memakai Monad Testnet dan jenis tugas payout USDC yang sama. Perluasan MVP ada pada alur pengguna, runner, pemulihan operasi, dan bukti integrasi nyata—bukan pada token, chain, atau jenis tugas baru.

Dokumen lama di bagian Arsip di bawah ini. Tidak ada data atau alamat jaringan lama yang dibawa ke deployment baru.

## 4. Jaringan dan dependensi yang harus diverifikasi

| Komponen | Konfigurasi P0 | Preflight wajib |
| --- | --- | --- |
| Chain | Monad Testnet, chain ID `10143` | Baca `eth_chainId` dari RPC yang digunakan |
| Gas | MON | Cek saldo tiap wallet dan gas limit tiap aksi |
| USDC testnet | Kandidat `0x534b2f3A21130d7a60830c2Df862319e593943A3` | Cocokkan dokumentasi resmi terbaru, bytecode, identitas token, `decimals() = 6` |
| RPC | Dua endpoint Monad Testnet yang independen | Cek chain ID, kode kontrak, job, transaksi, dan receipt dari kedua sumber |
| Storage | Kubo lokal atau Pinata publik | Tulis JSON, baca ulang byte yang sama, cocokkan hash |
| Explorer | MonadVision Testnet | Pastikan hash dan alamat membuka data pada chain yang sama |

Sumber resmi: [Monad Testnet](https://docs.monad.xyz/developer-essentials/testnet), [panduan USDC testnet](https://docs.monad.xyz/guides/x402), dan [gas pricing Monad](https://docs.monad.xyz/developer-essentials/gas-pricing). Fakta yang dapat berubah harus dicek ulang sebelum broadcast. Dokumentasi resmi menyatakan Monad mengenakan biaya berdasarkan **gas limit**, sehingga operator tidak boleh menaikkan limit sembarangan. MON dan USDC testnet dapat disiapkan lewat faucet yang dirujuk dokumentasi; faucet bukan bagian dari runtime produk.

## 5. Arsitektur dan batas kepercayaan

```text
Buyer ─propose/fund/cancel─> XYXDeliveryProtocol <─submitDelivery hash─ Provider
                         │  job state + escrow                │
                         │                                    └─USDC.transfer─> Recipient
                         ▲
                         │ resolveJob(verdict + WebAuthn/P256 assertion)
                    Attestor  (msg.sender harus == job.attestor)
                         ▲
                         │ verify assertion + counter
                    XYXPasskeyRegistry
                         ▲
                         │ P256.verifyNative
                    MonadP256Verifier

Penonton ─> /demo ─> RPC + canonical manifest + IPFS + explorer
```

Relayer, bila dipakai, hanyalah pembayar gas di luar diagram otoritas kontrak.

`XYXDeliveryProtocol` memegang dana dan status. Attestor menandatangani `JobVerdict` EIP-712 dan mengirimkannya bersama assertion WebAuthn/P256; kontrak memeriksa commitment job/delivery, decision, waktu, replay, lalu meminta registry memverifikasi assertion. Verifier off-chain membaca fakta dan menulis evidence. IPFS menyimpan byte spesifikasi/evidence; hash on-chain dan dalam manifest dipakai untuk mendeteksi perubahan. Attestor adalah pihak tepercaya: kontrak tidak dapat menjamin attestor membaca receipt yang benar, dan tidak ada mekanisme penahanan verdict di luar kedaluwarsaan. Pemisahan relayer pembayar gas mengurangi risiko satu kunci operasional, tetapi tidak membuat verifikasi trustless.

## 6. Alur end to end

### 6.1 Persiapan sebelum ada job

1. Build dan uji source; catat commit, versi compiler, dan artefak kontrak.
2. Siapkan RPC dan baca chain ID. Verifikasi token USDC testnet, desimal, serta kode kontraknya.
3. Siapkan deployer, buyer, provider, attestor, dan (opsional) relayer pembayar gas. Cek alamat operasional berbeda; cek saldo MON untuk semua pengirim transaksi dan USDC buyer/provider. Tidak ada alamat admin atau pauser yang perlu disiapkan karena kontrak kanonis tidak memilikinya.
4. Siapkan Kubo/Pinata. Lakukan uji tulis → baca ulang → hash sama. Jika storage tidak tersedia, jangan mulai alur verdict.
5. Deploy `MonadP256Verifier`, `XYXPasskeyRegistry`, lalu `XYXDeliveryProtocol`. Deployment script menolak chain selain 10143. Catat alamat, transaction hash, block, constructor args, verified source. Jangan mengklaim deployment hanya dari output simulasi Foundry.

### 6.2 Membuat spesifikasi

Buyer dan provider menyepakati recipient, provider, jumlah tugas, hadiah, serta expiry. Operator membangun `PrivateTermsInput` versi `xyx.private-terms` (lihat 8.1) dan menghitung `termsCommitment` dengan fungsi SDK `createTermsCommitment(terms, salt)` — yaitu keccak atas konkatenasi domain separator 32 byte, byte JSON kanonik dari terms, dan salt 32 byte (bukan `abi.encode`). `acceptancePolicy` adalah bagian dari payload privat; ia tidak diteruskan ke kontrak. Deskripsi job on-chain hanya berisi `termsCommitment` dan `expiresAt`. Jika ada perubahan instruksi, buat job baru; jangan mengedit interpretasi hash lama.

### 6.3 Membuat dan mendanai job

1. Buyer memanggil `proposeJob(provider, attestor, termsCommitment, budgetAtomic, expiresAt)` sesuai urutan ABI kontrak. Kontrak menolak buyer yang sama dengan provider atau attestor, serta provider yang sama dengan attestor. Terbit `JobProposed`, status `Proposed`, dan `jobId` baru. Belum ada dana terkunci.
2. Provider memanggil `acceptJob(jobId)`. Ini bukan persetujuan atas attestor — attestor sudah dikunci saat `proposeJob`. Status menjadi `Accepted`.
3. Buyer melakukan `USDC.approve(protocol, budgetAtomic)` jika allowance kurang.
4. Buyer memanggil `fundJob(jobId)` sebelum expiry; kontrak menarik sebesar `job.budget`. Status menjadi `Funded`. Receipt approval saja tidak boleh ditampilkan sebagai funding.
5. Provider baru melaksanakan tugas setelah receipt funding sukses dan `getJob` menunjukkan budget/status yang disepakati.

Belum ada fungsi `setBudget` di kontrak kanonis: budget ditetapkan sekali saat `proposeJob` dan tidak dapat diubah setelahnya.

### 6.4 Melaksanakan dan menyerahkan tugas

Provider mengirim `USDC.transfer(recipient, amountAtomic)` dari alamat provider. Setelah receipt tersedia, provider memanggil `submitDelivery(jobId, deliveryCommitment)` sebelum expiry. Kontrak menyimpan `deliveryCommitment` dan status menjadi `Submitted`. Kontrak belum menilai apakah transfer itu benar, dan tidak menyimpan evidence maupun reason commitment.

Kontrak **tidak** mencatat block funding/submission. Verifier off-chain yang memeriksa urutan transfer hanya dapat mengandalkan timestamp/block dari RPC atau explorer, bukan field on-chain; aturan urutan lama berbasis `fundedAtBlock < transferBlock < submittedAtBlock` milik `AgenticCommerce` yang sudah pensiun dan tidak ada pada `XYXDeliveryProtocol`.

### 6.5 Verifikasi, verdict, dan settlement

Attestor mendaftarkan passkey ke `XYXPasskeyRegistry` untuk protocol ini. Verifier membaca job on-chain, commitments, dan delivery evidence. Hasil hanya boleh:

- `COMPLETE`: semua sumber tersedia dan seluruh syarat cocok.
- `REJECT`: sumber tersedia dan lengkap, tetapi mismatch nyata ditemukan, misalnya recipient salah.
- `UNVERIFIED`: RPC/IPFS tidak tersedia, receipt belum ada/stabil, data tidak konsisten, atau job tidak memenuhi prasyarat. Ini **bukan** penolakan provider.

Attestor menandatangani `JobVerdict` EIP-712 dengan `jobId`, `termsCommitment`, `deliveryCommitment`, `evidenceCommitment`, `reasonCommitment`, `decision`, `issuedAt`, `expiresAt`, dan `nonce`. Attestor memanggil `resolveJob(verdict, assertion)` dari alamatnya sendiri — kontrak menolak `msg.sender != job.attestor`, sehingga relayer independen **tidak** dapat mengirim verdict kecuali ia memang attestor job tersebut. Relayer independen hanya dapat membayar gas untuk `claimExpiryRefund` yang permissionless.

Kontrak memverifikasi nilai `termsCommitment` dan `deliveryCommitment` yang di-commit pada job, decision, `issuedAt`/`expiresAt` terhadap `maxVerdictLifetime`, replay (`usedNonces`, `consumedVerdicts`), dan assertion WebAuthn/P256 terhadap passkey terdaftar milik attestor; baru kemudian escrow dilepas. Keputusan `1` membayar `job.budget` ke provider (status `Completed`); keputusan `2` mengembalikan `job.budget` ke buyer (status `Rejected`). Keduanya terbit sebagai event `PaymentReleased` di transaksi verdict yang sama; jika panggilan escrow atau passkey revert, keseluruhan transaksi revert dan replay markers tidak terbakar.

Jika attestor tidak mengirim verdict sebelum `expiresAt`, siapa pun dapat memanggil `claimExpiryRefund(jobId)`; budget kembali ke buyer dan status menjadi `Expired` (event `JobExpired`).

**Yang tidak diperiksa kontrak:** kebenaran evidence, kualitas pekerjaan, dan isi reason. Kontrak hanya mengikat attestor yang sah pada nilai yang sudah ter-commit.

### 6.5.1 Jev AI Evidence Assessment (extension off-chain, opsional)

Jev digunakan hanya untuk membantu attestor menilai **kesiapan evidence**, bukan menentukan kebenaran settlement. Integrasi memakai System One API TypeSafe (`POST /v1/systemone`) dengan output keputusan terstruktur dan confidence. Dokumentasi API resmi saat ini menetapkan `jev-latest` sebagai model flagship; model konkret yang benar-benar melakukan evaluasi harus tetap diambil dari field `model` pada respons dan dicatat sebagai fakta runtime, bukan diklaim lebih dulu. Lihat [dokumentasi API TypeSafe](https://docs.typesafe.ai/api) dan [penjelasan Jev/RLCD dari TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Status fitur ini adalah **pasca-P0 / optional**. Tidak adanya API key, akses Jev, atau hasil assessment tidak boleh menghambat verifier kanonis, passkey attestor, `resolveJob`, refund expiry, ataupun tiga run live P0. Fitur tidak boleh ditampilkan seolah-olah sudah aktif sebelum backend benar-benar menerima respons Jev yang tervalidasi.

#### Larangan mock dan simulasi Jev

Tidak ada mode mock, local fallback, canned JSON, fixture response, endpoint stub, atau model pengganti yang boleh menghasilkan assessment berstatus `AVAILABLE`. Card Jev hanya boleh menunjukkan `AVAILABLE` jika server berhasil menerima dan memvalidasi respons dari API Jev resmi dengan credential yang sah. Jika credential belum disediakan, akses belum tersedia, request gagal, atau respons tidak tervalidasi, satu-satunya state yang sah adalah `UNAVAILABLE`. Larangan ini berlaku untuk UI demo, preview, acceptance evidence, dan test yang dapat terlihat sebagai bukti integrasi; hasil sintetis tidak boleh diberi nama, logo, model version, confidence, atau status seolah-olah berasal dari Jev.

#### Batas otoritas

1. Jev tidak dapat membuat, menandatangani, mengirim, atau mensponsori transaksi.
2. Jev tidak dapat memanggil `resolveJob`, mengubah state job, mengubah amount escrow, membuat `JobVerdict`, atau mengubah hasil `COMPLETE`, `REJECT`, dan `EXPIRED` di chain.
3. Hanya attestor yang tetap membuat keputusan akhir dan membuktikannya dengan assertion WebAuthn/P256. Rekomendasi Jev tidak mengurangi kewajiban review manusia.
4. Hasil Jev tidak dapat menaikkan badge `/demo` menjadi `LIVE_VERIFIED`; badge itu tetap hanya berasal dari state dan receipt yang cocok pada dua RPC independen.
5. Pada P0, hasil Jev bukan canonical evidence, bukan input wajib `reasonCommitment`, dan tidak ditulis ke contract, canonical manifest, atau IPFS. Pengikatan digest assessment ke provenance hanya dapat dipertimbangkan pada versi protokol/data baru setelah consent, retention, dan model ancamannya ditinjau.

#### Arsitektur target

```text
Private / redacted delivery facts
        │
        ▼
XYX server-side Jev adapter ──POST /v1/systemone──> TypeSafe Jev
        │                                             │
        │<── typed recommendation + confidence ───────┘
        ▼
Attestor UI: advisory card only
        ▼
Attestor review + WebAuthn/P256 assertion
        ▼
XYXDeliveryProtocol: canonical COMPLETE / REJECT / EXPIRED settlement
```

API key hanya boleh dibaca oleh server-side adapter, misalnya endpoint target `POST /api/jev/evaluate-delivery`. Browser tidak pernah memanggil TypeSafe secara langsung dan tidak pernah menerima `TYPESAFE_API_KEY`; nama environment tersebut tidak boleh memakai awalan `NEXT_PUBLIC_` dan tidak boleh masuk Git, manifest, IPFS, browser bundle, log, atau pesan error.

#### Kontrak input yang diizinkan

Adapter mengirim state minimal yang diperlukan untuk menjawab pertanyaan. Default-nya adalah ringkasan terstruktur yang telah divalidasi, bukan bukti mentah.

```json
{
  "schema": "xyx.jev-evidence-input.v1",
  "policyVersion": "evidence-readiness.v1",
  "jobContext": {
    "jobId": "12",
    "taskClass": "erc20-transfer-proof",
    "termsSummary": "Provider must transfer the agreed token, amount, and recipient before expiry."
  },
  "deliveryFacts": {
    "submittedBeforeExpiry": true,
    "tokenMatches": true,
    "senderMatches": true,
    "recipientMatches": true,
    "amountMatches": true,
    "receiptFinalizedOnBothRpcs": true,
    "requiredEvidencePresent": true
  }
}
```

Input tidak boleh memuat private key, API key, seed phrase, passkey credential ID, PRF output, authenticator data, client data JSON, signature, upload credential, cookie, URL bertoken, data pribadi yang tidak perlu, atau raw private terms/evidence secara default. Hash semata tidak dikirim sebagai pengganti evidence yang perlu dipahami model. Jika suatu use case benar-benar membutuhkan konten evidence, aplikasi harus memperoleh consent eksplisit dan mengirim versi minimal yang disensor; use case itu berada di luar P0.

#### Pertanyaan dan output yang diizinkan

Panggilan pertama menggunakan satu `choice` question dengan pilihan tertutup berikut:

```text
READY              Semua fakta yang diperlukan tersedia dan konsisten untuk review attestor.
NEED_MORE_EVIDENCE Bukti belum cukup, tetapi belum ada kontradiksi yang terbukti.
SUSPICIOUS         Ada fakta yang bertentangan atau indikator risiko yang memerlukan review manual.
```

Response server harus divalidasi terhadap bentuk internal berikut sebelum dikirim ke UI:

```json
{
  "schema": "xyx.jev-evidence-assessment.v1",
  "status": "AVAILABLE",
  "provider": "typesafe",
  "model": "model-id-returned-by-provider",
  "policyVersion": "evidence-readiness.v1",
  "recommendation": "READY",
  "confidence": 0.91,
  "assessedAt": "runtime ISO-8601 timestamp"
}
```

`recommendation` hanya boleh `READY`, `NEED_MORE_EVIDENCE`, atau `SUSPICIOUS`; `confidence` harus finite dan berada pada rentang 0 sampai 1. Response tidak dikenal, model/provider mismatch, status HTTP gagal, timeout, payload terlalu besar, atau validasi gagal menghasilkan:

```json
{
  "schema": "xyx.jev-evidence-assessment.v1",
  "status": "UNAVAILABLE",
  "reason": "stable-non-secret-error-code"
}
```

Tidak boleh ada fallback yang membuat recommendation, confidence, model version, atau timestamp palsu. `UNAVAILABLE` berarti assessment AI tidak tersedia; itu bukan `REJECT`, bukan evidence gagal, dan bukan kegagalan chain.

#### Aturan UI dan keputusan manusia

- `READY` dengan confidence minimal 0,90 boleh menampilkan teks **“Suggested manual path: review for COMPLETE”**. Ini bukan auto-approval dan tidak mengaktifkan atau menekan tombol settlement.
- `NEED_MORE_EVIDENCE`, `SUSPICIOUS`, atau confidence di bawah 0,90 mengarahkan UI ke review manual. Tidak ada status yang dapat auto-mengirim `COMPLETE` atau `REJECT`.
- Card wajib membawa label **“Off-chain AI recommendation — not settlement evidence”**, nama model yang benar-benar menjawab, policy version, confidence, dan status availability.
- Saat Jev belum dikonfigurasi atau gagal, card menampilkan **“AI assessment unavailable”** tanpa dummy score, dummy model, atau transaksi simulasi. Alur passkey/manual tetap dapat digunakan.
- Endpoint harus dibatasi ke konteks review yang sah; ia tidak boleh menjadi proxy publik tanpa autentikasi/rate-limit yang dapat menghabiskan quota API.

Confidence adalah sinyal operasional, bukan bukti bahwa satu keputusan pasti benar. Sebelum threshold digunakan untuk mempengaruhi UX, operator harus mengevaluasi calibration pada dataset berlabel yang relevan dan mencatat model serta policy version. Penggantian model mengharuskan evaluasi ulang; alias model bergerak tidak boleh dianggap setara dengan model yang telah dievaluasi.

### 6.6 Hasil akhir dan refund

`Completed`: escrow mengirim hadiah ke provider. `Rejected`: escrow mengembalikan hadiah ke buyer. `Expired`: setelah `expiredAt`, siapa pun dapat memanggil `claimExpiryRefund` untuk job `Funded` atau `Submitted`; buyer menerima hadiah kembali tanpa verdict attestor. UI wajib memeriksa status final serta log transfer hadiah, bukan hanya field `decision` di file lokal.

## 7. State machine kontrak

| Awal | Aksi | Aktor | Syarat | Akhir |
| --- | --- | --- | --- | --- |
| Belum ada | `proposeJob` | Pemanggil menjadi buyer | Provider/attestor valid, buyer≠provider≠attestor, expiry masa depan | `Proposed`; dana belum masuk |
| `Proposed` | `acceptJob` | Provider | Job masih `Proposed`, provider = `job.provider` | `Accepted`; attestor sudah dikunci sejak `proposeJob` |
| `Proposed` | `cancelProposal` | Buyer | Job masih `Proposed`, pemanggil = `job.buyer` | `Cancelled` |
| `Accepted` | `fundJob` | Buyer | Job `Accepted`, sebelum expiry, allowance cukup | `Funded`; buyer → escrow |
| `Funded` | `submitDelivery` | Provider | Job `Funded`, sebelum expiry, `deliveryCommitment` nonzero | `Submitted`; hanya commitment tersimpan |
| `Submitted` | `resolveJob` | Attestor job (`msg.sender == job.attestor`) | Verdict EIP-712 sah untuk commitment job & delivery, decision 1/2, belum kedaluwarsa (job maupun verdict), nonce/digest belum terpakai, assertion WebAuthn/P256 lolos | `Completed` (decision=1) atau `Rejected` (decision=2) |
| `Funded` atau `Submitted` | `claimExpiryRefund` | Siapa pun | Waktu chain melewati expiry | `Expired`; escrow → buyer |

Status `Proposed`, `Accepted`, dan `Funded` juga kedaluwarsa hanya lewat `claimExpiryRefund` bila masuk rentang yang ditentukan kontrak; `Cancelled` hanya tercapai dari `Proposed`.

Status final tidak bisa diubah dan hadiah tidak boleh keluar dua kali. Escrow menggunakan SafeERC20 dan ReentrancyGuard pada jalur dana. Kontrak menolak pemanggil bukan attestor, decision tidak dikenal, hash kosong, verdict basi (job maupun verdict melewati `expiresAt`), nonce/digest ulang, domain tanda tangan yang salah, dan assertion P256 yang gagal verifikasi. Nonce dan digest yang sudah dipakai baru ditulis setelah semua panggilan eksternal berhasil, sehingga assertion yang gagal tidak membakar penanda replay. Mapping nonce tumbuh terus; ini diterima untuk pilot dan bukan mekanisme produksi tanpa peninjauan biaya storage.

**Tidak ada pause.** Tidak ada state yang menahan `resolveJob` saat `claimExpiryRefund` tetap jalan; keduanya hanya terbatas waktu.

## 8. Kontrak data

### 8.1 Syarat privat

```json
{
  "schema": "xyx.private-terms",
  "chainId": 10143,
  "protocol": "0x...",
  "paymentToken": "0x...",
  "buyer": "0x...",
  "provider": "0x...",
  "attestor": "0x...",
  "budgetAtomic": "20000",
  "expiresAt": 1700003600,
  "task": { ... },
  "acceptancePolicy": { ... }
}
```

`budgetAtomic` adalah string integer positif. Dengan enam desimal, `20000` = 0,02 USDC. `expiresAt` adalah detik Unix. Schema menolak field tambahan. `task` dan `acceptancePolicy` wajib berisi minimal satu entri. Alamat divalidasi bentuknya lalu dibandingkan tanpa membedakan kapitalisasi, dan protokol/token/buyer/provider/attestor tidak boleh sama satu dengan lain. `protocol` dan `paymentToken` tidak boleh `0x0000000000000000000000000000000000000000`. `chainId` mengikat versi protokol; versi baru harus memakai `chainId` baru. Semua field di objek ini bersifat privat/off-chain: satu-satunya representasi on-chain-nya adalah `termsCommitment`.

### 8.2 Komitmen, verdict, dan manifest

- `canonicalJSON` menyortir key object secara rekursif; Keccak-256 dihitung atas byte UTF-8 hasilnya.
- Terms commitment mengikat seluruh `PrivateTermsInput`. Delivery commitment mengikat `PrivateDeliveryInput`. Evidence dan reason commitment mengikat bukti verifikasi.
- Manifest kanonis (`kind: 'xyx.monad.canonical-manifest.v1'`) berisi `chainId`, `protocol`, `token`, `generatedAt`, dan array runs.
- Setiap run adalah discriminated union pada `outcome`:
  - `COMPLETE`: outcome=COMPLETE, decision=COMPLETE, `termsCommitment`, `deliveryCommitment`, `evidenceCommitment`, `reasonCommitment`, `issuedAt`, `expiresAt`, `nonce`, `resolveTx`
  - `REJECT`: outcome=REJECT, decision=REJECT, field yang sama
  - `EXPIRED`: outcome=EXPIRED, `refundTx` saja — tidak boleh mengandung field verdict
- `expiresAt` harus lebih besar daripada `issuedAt`. Komitmen nol (`0x` + 64 nol) ditolak. Address `0x0000000000000000000000000000000000000000` ditolak.
- Manifest dan setiap run harus memiliki protocol dan token yang sama, non-zero, dan cocok satu sama lain.

### 8.3 Verifikasi settlement

Dua RPC independen membaca state job yang finalized pada block yang sama. Kedua sumber harus cocok byte-per-byte: job state, receipt, event `JobResolved` atau `JobExpired`, token transfer escrow, dan block hash.

| Kasus | Event | Penerima reward | Bukti tambahan |
| --- | --- | --- | --- |
| COMPLETE | `JobResolved` + `PaymentReleased` dari escrow | Provider, sebesar budget | Verdict decision 1, verdict commitment cocok dengan job, hasil recompute COMPLETE |
| REJECT setelah funding | `JobResolved` + `PaymentReleased` dari escrow | Buyer, sebesar budget | Verdict decision 2 dan hasil recompute REJECT |
| EXPIRED | `JobExpired` + `PaymentReleased` dari escrow | Buyer, sebesar budget | Timestamp block refund >= `expiresAt`; tidak mensyaratkan verdict |

Transfer harus berasal dari escrow dan dipancarkan token yang disepakati. Funding juga dibuktikan melalui receipt, `JobFunded`, serta `Transfer` buyer → escrow. Kontrak kanonis tidak memiliki event `Refunded`; event itu milik `AgenticCommerce` yang sudah pensiun. Jika job dibatalkan saat `Proposed` lewat `cancelProposal`, tidak ada dana yang keluar karena escrow masih kosong; UI tidak boleh mengklaim refund pada kasus itu.

## 9. Halaman `/demo` dan pengalaman juri

`/demo` adalah observer publik read-only, bukan antarmuka transaksi MVP. Alur browser `/reference` kini menyiapkan transaksi wallet nyata untuk buyer, provider, attestor, serta refund dan hanya boleh menampilkan keberhasilan setelah observasi finalized dari dua RPC. Ini **belum** membuktikan MVP end-to-end: jalur tersebut belum diuji dengan deployment Monad Testnet nyata, handoff terms/delivery saat ini berupa berkas privat manual, dan pemulihan operasi tahan lama serta publikasi evidence/manifest masih terbuka. Panel yang sekadar menyiapkan request atau menampilkan data `SIMULATED` tetap tidak memenuhi kriteria MVP.

1. Jelaskan nilai produk dalam satu kalimat dan tampilkan langkah commit → fund/execute → verify → settle.
2. Tampilkan kartu dengan label verifikasi terpisah dari klaim manifest: `LIVE_VERIFIED`, `PENDING`, `UNVERIFIED`, `REJECT`, atau `CONFLICT`. `LIVE_VERIFIED` memerlukan semua receipt, state, hash, dan log settlement yang cocok.
3. Tiap kartu menampilkan: "Claimed outcome" (dari manifest) dan "Observed chain status" (hanya dari verifikasi on-chain yang berhasil). Jika verifikasi gagal, observed status adalah "Unavailable".
4. Tampilkan job ID, status final, alamat kontrak, expiry, spec/evidence hash dan URI, serta tautan explorer untuk tiap transaksi yang tersedia.
5. Jelaskan bahwa attestor menandatangani keputusan; jangan memberi kesan kontrak membaca IPFS sendiri.
6. Bila RPC/IPFS gagal, receipt hilang, atau manifest tidak cocok dengan chain, turunkan label menjadi `UNVERIFIED` atau `CONFLICT`; jangan mempertahankan hasil sukses lama.
7. Tanpa run live, tampilkan empty state. Fixture dan transaksi yang baru disiapkan tidak boleh terlihat sebagai kejadian nyata.
8. Jika Jev diaktifkan pasca-P0, tampilkan recommendation sebagai card advisory yang terpisah dari claimed outcome, observed chain status, dan badge settlement. Jangan tampilkan card simulasi sebagai respons provider nyata.

## 10. Kegagalan dan pemulihan

| Kejadian | Respons produk | Tindakan operator |
| --- | --- | --- |
| Chain ID/RPC salah | Tidak broadcast | Ganti RPC, ulang preflight |
| Token/kode kontrak salah | Tidak fund | Verifikasi bytecode, decimals, binding deployment |
| MON, USDC, atau allowance kurang | Tidak klaim langkah berikutnya | Danai wallet yang tepat; cek ulang receipt/state |
| IPFS tulis/readback gagal | Tidak sign verdict | Pulihkan storage lalu ulang verifikasi |
| Receipt transfer belum ditemukan | `UNVERIFIED`, bukan `REJECT` | Tunggu atau cek RPC kedua |
| Transfer lengkap tetapi salah | `REJECT` dengan failure code | Periksa observed dan persetujuan attestor |
| Broadcast berhasil tetapi command timeout | Jangan broadcast ulang buta | Rekonsiliasi hash, nonce, receipt, event, dan job |
| Verdict basi atau job expired | Verdict apa pun (COMPLETE maupun REJECT) setelah `expiresAt` job revert; job memakai `claimExpiryRefund` | Aplikasi memakai `claimExpiryRefund` setelah expiry; tidak ada verdict yang sah melewati expiry |
| Attestor dikompromi | Tidak ada mekanisme kontrak untuk membatalkan attestor atau menghentikan verdict baru | Mitigasi di luar kontrak: job yang sudah terlanjur terbuka tetap bergantung pada attestor tersebut; job baru harus memilih attestor baru. Ini keputusan produk yang belum diimplementasi |
| Jev tidak dikonfigurasi, timeout, atau respons tidak valid | `AI assessment unavailable`; tidak ada recommendation atau score | Review evidence manual; jangan mengubah job atau settlement |
| Input Jev mengandung data berlebih/rahasia | Jangan kirim request; catat kode error non-rahasia | Sanitasi ke fakta minimum, peroleh consent jika konten evidence memang diperlukan |

Gas limit perlu diukur dan dibatasi karena Monad mengenakan biaya menurut limit. Catatan operasi tidak boleh menyimpan kunci. Refund expiry tetap tersedia karena bersifat permissionless dan tidak sandra pada attestor.

## 11. Keamanan dan model ancaman

- **Spec diubah:** cocokkan byte IPFS dan hash terhadap description on-chain; cek buyer/job.
- **Hash transaksi orang lain:** cocokkan `transaction.from` dan `Transfer.from` dengan provider.
- **Token, penerima, atau jumlah salah:** cocokkan target transaksi, alamat log, `to`, dan `value` tepat.
- **RPC keliru:** ulangi pemeriksaan melalui explorer atau RPC kedua sebelum demo publik; RPC tunggal adalah asumsi kepercayaan operasional.
- **Transfer lama/replay:** pada kontrak kanonis, mitigasi berbasis block anchor (`fundedAtBlock < transferBlock < submittedAtBlock`) dan reservasi hash deliverable **tidak ada**. Aturan itu hanya dimiliki `AgenticCommerce` yang sudah pensiun; verifier off-chain harus memeriksa urutan transfer dari data RPC/explorer tanpa field on-chain sebagai jangkar. Status: gap dokumentasi/implementasi, bukan fitur kanonis. Lihat blueprint bagian 3.1.
- **Replay verdict:** domain EIP-712 mengikat chain/kontrak; nonce dan digest dikonsumsi; waktu dibatasi oleh `maxVerdictLifetime` serta `expiresAt` job.
- **Attestor salah/kolusi:** tidak ada check permissionless yang membuat keputusan trustless; evidence harus bisa diaudit publik. Commitment hanya mengikat attestor yang sah pada nilai yang sudah ter-commit.
- **Double settlement/reentrancy:** status final, SafeERC20, dan ReentrancyGuard harus diuji secara adversarial; audit independen diperlukan sebelum nilai nyata.
- **Kebocoran kunci:** private key hanya di environment lokal/secret manager; jangan masuk browser, Git, run file, atau IPFS.
- **Passkey assertion:** assertion P256 diverifikasi on-chain oleh `MonadP256Verifier` melalui precompile native Monad (`P256.verifyNative`, tanpa fallback Solidity); rp ID hash dibandingkan dengan binding registry dan counter authenticator harus monoton. Registry tidak memakai PRF output — PRF tidak ada pada jalur kanonis.
- **Rekomendasi Jev salah atau overconfident:** Jev hanya memberikan sinyal off-chain; attestor tetap bertanggung jawab atas verdict. UI tidak boleh memperlakukan confidence sebagai fakta chain atau auto-settlement. Threshold hanya digunakan setelah evaluasi calibration yang terdokumentasi.
- **Kebocoran data ke provider AI:** adapter mengirim fakta minimal yang disensor dan API key tetap server-side. Raw evidence/private terms memerlukan consent eksplisit; passkey material dan secret tidak pernah dikirim.
- **Ketergantungan pada satu provider AI:** Jev adalah adapter opsional, bukan dependency protocol. Jika provider hilang atau diganti, settlement manual dan verifier kanonis tetap berfungsi tanpa perubahan contract.

## 12. Kriteria penerimaan dan tes

### Kontrak

- Foundry membuktikan sukses membayar provider sekali; reject/refund membayar buyer sekali; expiry mengembalikan dana; status final tidak dapat diubah.
- Tes mencakup aktor salah, signer/attestor salah, domain chain/contract salah, nonce ulang, verdict basi, boundary expiry, transfer token yang revert, dan verifikasi signature P256 gagal. Tidak ada tes pause karena kontrak kanonis tidak memiliki pause.
- Deploy script menolak chain yang salah dan input kosong; deployment live harus dibuktikan dari receipt serta kode on-chain.

Tes yang tercatat di repo terbagi dua: tes kontrak kanonis (`XYXDeliveryProtocol.t.sol` dan `XYXDeliveryProtocolSecurity.t.sol`) serta tes kontrak pensiun (`C1Hardening.t.sol` dan `MonadLifecycle.t.sol` yang menjalankan `AgenticCommerce` dan `XYXEvaluator`). Hanya tes kanonis yang boleh dikutip sebagai bukti `XYXDeliveryProtocol`. Jumlah persis dihitung ulang setiap kali gate dijalankan, bukan disalin dari laporan sebelumnya.

### Verifier dan storage

- Unit test mencakup transfer tepat, recipient/jumlah/token/sender salah, receipt revert, log palsu, spec/job salah, serta RPC/IPFS gagal.
- Test transfer lama dan replay lintas job/provider harus lulus sebelum Gap A dianggap selesai.
- Byte JSON yang sama menghasilkan hash sama; byte readback IPFS cocok dengan byte yang di-hash.
- Hanya mismatch yang terbukti menghasilkan `REJECT`; kegagalan memperoleh data menghasilkan `UNVERIFIED`.

### Bukti P0 end to end

- Setelah perubahan kode relevan jalankan `npm run test:contracts`, `npm test`, `npm run typecheck`, dan `npm run build:web`.
- Tiga job testnet berbeda mempunyai receipt, state akhir, dan log perpindahan USDC yang cocok.
- Juri dapat membuka manifest, IPFS, dan semua transaksi tanpa kunci operator.
- UI tetap jujur saat RPC/IPFS mati atau run belum ada.
- Tidak ada klaim deployment sebelum alamat, receipt sukses, block, dan source terverifikasi dicatat.

### MVP end-to-end

- Uji integrasi mencakup seluruh transisi dari wallet buyer hingga hasil final yang diamati, termasuk wallet/chain salah, allowance kurang, job expired, passkey gagal, RPC/IPFS mati, broadcast ambigu, restart, dan duplicate event. Test lokal tidak boleh memakai state sintetis sebagai bukti transaksi live.
- Jalur COMPLETE, REJECT, dan EXPIRED dijalankan melalui antarmuka/runner produk dengan tiga job Testnet nyata; catat transaksi, receipt finalized, state, event, dan transfer escrow yang cocok pada dua RPC. Juri dapat mengikuti hasil dari perangkat tanpa credential operator.
- Operasi normal tidak membutuhkan edit JSON, penyalinan hash manual, atau CLI operator; CLI pemulihan tetap boleh ada sebagai jalur darurat. Tidak ada secret buyer/provider/attestor di server publik atau Git.
- Release owner memeriksa source, gate, deployment/source verification, bukti live, pemulihan, dan batas trust sebelum memberi label MVP. P0 yang lulus saja belum memenuhi kriteria ini.

### Jev AI Evidence Assessment (pasca-P0, bila diaktifkan)

- Test memverifikasi API key tidak diekspos ke client bundle, `NEXT_PUBLIC_*`, log, error response, manifest, maupun IPFS.
- Test memverifikasi adapter hanya menerima input schema yang diizinkan dan menolak private key, passkey material, URL bertoken, dan field evidence mentah yang tidak diizinkan.
- Test otomatis hanya boleh membuktikan perilaku fail-closed tanpa credential atau tanpa respons tervalidasi: UI harus menunjukkan `UNAVAILABLE` dan tidak menciptakan assessment sintetis. Tidak ada test fixture/stub yang boleh menghasilkan card `AVAILABLE`.
- Bukti bahwa card `AVAILABLE` berfungsi memerlukan satu panggilan nyata dan terdokumentasi ke API Jev resmi menggunakan input demo/non-sensitif. Bukti itu harus mencatat model yang benar-benar merespons dan timestamp runtime, tanpa membocorkan API key atau data input privat.
- Test membuktikan tidak ada jalur dari response Jev ke `resolveJob`, builder settlement, signer WebAuthn, perubahan canonical manifest, atau badge `LIVE_VERIFIED`.
- Test membuktikan confidence di bawah threshold tidak menghasilkan suggestion `COMPLETE`, dan semua recommendation tetap memerlukan tindakan passkey attestor yang terpisah.
- Sebelum demo menyebut angka confidence sebagai calibrated, gunakan dataset berlabel yang dipisahkan dari data tuning dan catat model ID, policy version, ukuran sampel, serta hasilnya. Tanpa evaluasi tersebut, tampilkan confidence hanya sebagai nilai provider, bukan klaim akurasi XYX.

**Definition of done P0:** kriteria kontrak, verifier/storage, dan bukti P0 end to end di atas lulus; Gap A dan D ditutup atau klaim publik dipersempit secara tegas; tiga run live bisa diperiksa mandiri. Kriteria MVP end-to-end adalah gate rilis berikutnya, bukan syarat untuk menyebut milestone P0 terbukti. Unit test lokal saja tidak cukup.

**Definition of done MVP:** kriteria P0 dan bagian MVP end-to-end di atas sama-sama terbukti. P0 bukan sinonim MVP; worker/runner dan antarmuka transaksi tidak boleh dipindahkan ke backlog opsional bila target rilisnya MVP.

## 13. Status implementasi saat dokumen ini ditulis

| Area | Sudah ada di repo | Belum dibuktikan atau belum selesai |
| --- | --- | --- |
| Kontrak kanonis | `MonadP256Verifier`, `XYXPasskeyRegistry`, `XYXDeliveryProtocol`, deploy script, tes lifecycle lokal (Foundry, hanya kontrak kanonis) | Deployment Monad Testnet dan audit independen belum tercatat. Rotasi/revocation attestor belum diimplementasi; belum ada keputusan produk |
| Spec/IPFS | Schema, canonical hash, Kubo/Pinata write-readback | Ketersediaan publik evidence belum dibuktikan |
| Verifier | Cek chain/job, direct calldata/log, block/waktu, finality, dan snapshot dua RPC | Bukti deployment/live belum selesai. Binding on-chain atas urutan transfer (block anchor) dan reservasi hash deliverable tidak ada di kontrak kanonis — hanya verifier off-chain atas data RPC |
| Web `/demo` | Baca manifest publik/IPFS, snapshot finalized, serta receipt settlement; verifikasi badge terpisah dari klaim manifest | Manifest/live URI, cross-RPC, dan UX job detail belum selesai |
| Alur transaksi MVP | Jalur browser `/reference` untuk wallet buyer/provider/attestor, cancel proposal, transfer tugas, registrasi/assertion WebAuthn, verdict, serta refund; hasil sukses dibatasi oleh receipt/state finalized dua RPC. Handoff terms/delivery normal memakai capability link AES-GCM dengan ciphertext persisten; berkas plaintext hanya jalur recovery eksplisit | Tidak ada bukti run browser di Testnet; publikasi evidence dan manifest masih terbuka. Handoff belum menggantikan jurnal operasi/receipt yang tahan restart |
| Runner/operasi MVP | SDK kanonis, CLI refund chain-only, jurnal hash/ID operasi publik di browser untuk mencegah retry sederhana, dan SQLite WAL satu-worker untuk ciphertext handoff privat | Jurnal server untuk intent/signer/nonce/receipt, pemulihan lintas perangkat/restart atas operasi chain, rekonsiliasi broadcast ambigu tanpa hash, dan runner provider terintegrasi belum terbukti end-to-end |
| Jev evidence assessment | Belum diintegrasikan; PRD mendefinisikan extension server-side advisory | Akses provider, API key server-side, adapter, privacy/consent review, evaluasi calibration, dan UX attestor belum dibuktikan |
| Skenario demo | Langkah dan command didefinisikan | Tiga receipt hasil live belum tercatat di repo |

Tabel status harus diperbarui dari bukti baru, bukan dari rencana atau fixture.

## 14. Urutan pengerjaan berikutnya

1. Lengkapi tes negatif kontrak untuk token gagal, verifier/domain/nonce, dan pemulihan broadcast ambigu. Kontrak kanonis tidak punya role, sehingga tidak ada tes role yang perlu ditulis; yang perlu ditutup tetap tercatat sebagai gap di bagian 2 dan 13 (pencabutan credential/attestor).
2. Verifikasi ulang fakta Monad, token, gas, IPFS, dan alamat; deploy, verifikasi source, catat receipt serta block. Kontrak kanonis tidak punya role yang perlu diverifikasi.
3. Jalankan tiga job live, audit melalui explorer/RPC kedua, publish manifest, lalu buka `/demo` dari perangkat tanpa credential operator.
4. Setelah ABI/schema kanonis stabil, bangun runner/SDK, operasi persisten, dan antarmuka transaksi buyer/provider/attestor/refund sebagai workstream wajib MVP; pekerjaan kode dapat berjalan paralel dengan persiapan bukti P0 selama kepemilikan file jelas. Tidak ada broadcast oleh implementator tanpa otorisasi manusia.
5. Jalankan ulang tiga skenario nyata melalui jalur produk terintegrasi, bukan hanya CLI operator; audit receipt/state dua RPC, bukti publik, serta recovery sebelum menyatakan MVP selesai.
6. Jev Evidence Assessment tetap extension opsional sesuai bagian 6.5.1; bila dikerjakan, gunakan respons provider nyata, review manual wajib, dan tanpa perubahan authority on-chain.

Tidak satu pun item dianggap selesai hanya karena PRD ini sudah ditulis.

---

## Arsip

Bagian ini memuat konten dari arsitektur lama yang tidak lagi merupakan jalur produk aktif. Kontrak, skrip, dan API di bawah ini **tidak digunakan** untuk alur kanonis dan tidak dipertahankan.

### Kontrak lama

| Komponen | File lama | Catatan |
| --- | --- | --- |
| Escrow | `AgenticCommerce.sol` | Digantikan `XYXDeliveryProtocol` |
| Evaluator | `XYXEvaluator.sol` | Digantikan passkey-backed attestor + `MonadP256Verifier` |
| Evaluator role | Kontrak lama menggunakan role `evaluator` | Tidak ada dalam alur kanonis; attestor menggunakan passkey |
| Payout manifest | Format `xyx.payout.v1` IPFS | Digantikan commitments kanonis dan manifest `xyx.monad.canonical-manifest.v1` |

### Skrip dan CLI lama

| Komponen | File | Status |
| --- | --- | --- |
| Demo CLI | `scripts/monad-demo.ts` | `LEGACY_SCRIPT_RETIRED` |
| Publish manifest | `scripts/publish-manifest.ts` | `LEGACY_SCRIPT_RETIRED` |
| CLI commands | `prepare`, `create`, `budget`, `fund`, `execute`, `evaluate`, `refund`, `inspect` | Tidak dipertahankan; gunakan SDK kanonis |

Arsip ini disimpan untuk referensi sejarah. Jangan tarik konten arsip ke alur produk aktif tanpa audit ulang.
