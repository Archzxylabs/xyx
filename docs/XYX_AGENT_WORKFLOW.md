# XYX agent workflow — shared engineering memory

Dokumen ini adalah memori kerja bersama yang tahan lintas sesi untuk manusia, Codex, dan Claude Code. Ia bukan pengganti bukti source, command output, receipt, atau dokumentasi resmi. Jika dokumen ini bertentangan dengan `AGENTS.md`, [PRD](XYX_MONAD_PRD.md), source kanonis, atau fakta chain yang diamati, sumber yang lebih kuat menang.

## Peran dan batas otoritas

| Pihak | Tanggung jawab | Tidak berwenang melakukan |
| --- | --- | --- |
| Human / release owner | Menentukan tujuan, memberi otorisasi eksternal, mereview checkpoint Git dan bukti live | Menjadikan laporan agen sebagai bukti tanpa memeriksa output/source/receipt |
| Codex | Memahami scope, membaca PRD/source, memecah task, menilai perubahan, mengaudit hasil, dan memberi prompt implementasi presisi | Menganggap test lokal sebagai aksi Testnet atau mengotorisasi deploy/merge secara otomatis |
| Claude Code / implementator | Mengubah file dalam scope, menulis test bermakna, menjalankan gate, lalu melaporkan fakta serta gap | Mengubah arsitektur/PRD/ABI di luar scope, memakai secret, atau membuat checkpoint tanpa instruksi human |
| Jev / TypeSafe | Mengklasifikasikan integrity laporan dan lane review dari report yang sudah disanitasi | Menulis code, mengakses repo, membaca secret, merge, deploy, broadcast, sign passkey, atau settle escrow |
| Foundry, TypeScript tests, RPC, explorer | Menjadi sumber fakta mekanis/chain | Menafsirkan tujuan produk atau mengambil keputusan scope sendiri |

## Prinsip yang tidak dapat dinegosiasikan

1. **Code dan bukti memegang kontrol.** Jev hanya memberi judgement terstruktur; ia tidak pernah menjadi pengambil tindakan.
2. **Evidence hierarchy:** source + test yang benar → command output aktual → receipt/state dua RPC → laporan implementator → judgement Jev. Urutan bawah tidak dapat menaikkan klaim di atasnya.
3. **Tidak ada bukti palsu.** Prepared request, fixture, simulasi, hash lokal, test, atau output build bukan deployment, broadcast, receipt, finality, source verification, maupun settlement live.
4. **Tidak ada secret di report.** Jangan kirim key, seed, credential/passkey material, URL bertoken, URL RPC, raw evidence privat, hash transaksi, output command mentah, atau diff/source penuh ke Jev.
5. **Tidak ada mock Jev.** `AVAILABLE` hanya sah setelah respons nyata TypeSafe berhasil diterima dan divalidasi. Tanpa key atau respons nyata, hasilnya `UNAVAILABLE`; tidak ada fake model, confidence, atau recommendation.
6. **Tidak ada aksi eksternal otomatis.** Jev, Codex, dan Claude tidak boleh menggunakan hasil triage untuk deploy, source verification, broadcast, merge, atau sign. Human tetap memberi otorisasi eksplisit.

## Siklus kerja standar

```text
Human objective
  → Codex: scope + source of truth + acceptance criteria
  → Claude: implementation in agreed file scope
  → deterministic gates: Foundry / Node / typecheck / web build
  → sanitized implementation report
  → Jev: integrity + next review lane (real API only)
  → Codex: inspect source and evidence, then state next action
  → Human: authorizes any external or irreversible action
```

Jev menjalankan dua pertanyaan independen dalam satu request:

- `claim_integrity`: `SUPPORTED`, `OVERSTATED`, atau `INSUFFICIENT_EVIDENCE`.
- `review_lane`: `CONTRACT_SECURITY`, `SDK_ABI`, `WEB_TRUTHFULNESS`, `CHAIN_OPERATIONS`, `DOCS_PRODUCT`, atau `PLATFORM_LEAD`.

Sebelum Jev dipanggil, code menentukan hard gate sendiri:

| Fakta deterministik | Hard gate |
| --- | --- |
| Ada Foundry/Node/typecheck/web gate gagal | `BLOCKED` |
| Salah satu gate belum dijalankan | `INCOMPLETE_LOCAL_EVIDENCE` |
| Semua gate lulus tetapi belum ada deployment, broadcast, receipt, dan source verification yang diamati | `LOCAL_EVIDENCE_ONLY` |
| Semua fakta live dilaporkan | `HUMAN_REVIEW_REQUIRED` |

Hard gate tidak dapat dinaikkan oleh Jev. Bahkan saat Jev memberi `SUPPORTED`, `HUMAN_REVIEW_REQUIRED` bukan izin deploy atau merge.

## Format laporan implementator

Claude menyusun file JSON lokal yang mengikuti `xyx.agent-work-report.v1`. File ini adalah input triage, bukan evidence publik dan tidak boleh di-commit bila mengandung fakta sensitif. Bentuknya memuat:

- task ID, judul, dan maksimal tiga area review;
- daftar path repository yang diubah;
- empat status gate: contracts, node, typecheck, web (`PASS`, `FAIL`, atau `NOT_RUN`);
- empat boolean observasi Testnet: deployment, broadcast, receipt, dan source verification;
- risiko yang belum terselesaikan, klaim, serta usulan langkah berikutnya dalam teks yang disanitasi.

Teks dengan key/credential, `Authorization`, URL, hash 32 byte, atau kata sensitif ditolak sebelum request Jev dibuat. Jangan mencoba menyamarkan secret agar lolos validasi.

## Menjalankan Jev workflow triage

1. Rotate key yang pernah terkirim di chat. Jangan mengirim key baru ke chat.
2. Buat file lokal yang diabaikan Git: `.env.workflow.local`.
3. Isi hanya nilai lokal berikut:

   ```env
   TYPESAFE_API_KEY=replace-with-a-new-rotated-key
   TYPESAFE_MODEL=jev-latest
   ```

4. Jalankan setelah semua gate relevan selesai dan implementator membuat report tersanitasi:

   ```bash
   npm run workflow:triage -- --input /path/to/sanitized-work-report.json
   ```

Command ini hanya melakukan satu request nyata ke `https://api.typesafe.ai/v1/systemone` jika credential tersedia. Ia tidak membaca deployment `.env`, tidak menulis file, tidak menghubungi Monad RPC, dan tidak membuat state chain. Exit `0` berarti respons Jev nyata tersedia; exit `1` berarti `UNAVAILABLE`; exit `2` berarti input/usage invalid. Hasilnya advisory dan harus dibaca bersama source serta gate output.

## Supervisi build dan correction loop

Untuk remediation provider-runner, gunakan `npm run workflow:supervise -- --input <checkpoint.json>` pada setiap checkpoint Prompt 06/07. Schema `xyx.implementer-checkpoint.v1` memuat Git baseline/head, ownership paths, hasil gate/check, ringkasan perubahan/test yang disanitasi, klaim, dan risiko. Codex atau release owner harus menyusun fakta tersebut dari inspeksi source dan command aktual; laporan implementator bukan sumber tunggal.

Supervisor menanyakan dua Choice (`claim_integrity`, `suggested_lane`) dan lima Noul defect independen (recovery evidence, error privacy, preflight side effects, pending reconciliation, dan test quality). Policy kode kemudian menghasilkan `nextAction` dan correction packet. Ownership/gate deterministik selalu menang. Correction packet boleh mengembalikan pekerjaan ke Prompt 06/07, tetapi tidak dapat mengotorisasi commit, merge, deploy, broadcast, signing, atau release. Tanpa respons TypeSafe nyata tervalidasi, action menjadi review manusia; tidak ada fallback sintetis.

Exit `0` hanya berarti hasil Jev nyata tervalidasi dan action efektif boleh maju ke reviewer atau review release manusia. Exit `1` berarti correction loop, gate deterministik, ketidakpastian, atau Jev unavailable masih memblokir kemajuan. Exit `2` berarti input/usage invalid. Walaupun exit `0`, manusia tetap memegang otorisasi checkpoint, commit, merge, dan release.

## Kapan Jev berguna dan kapan tidak

Gunakan untuk memilih lane review atau mendeteksi laporan yang overclaim setelah evidence mekanis dikumpulkan. Jangan gunakan untuk menemukan exploit Solidity, membuktikan ABI, memverifikasi receipt, memilih alamat/token, menyimpulkan keamanan kontrak, atau menggantikan audit. Untuk fakta mekanis, gunakan Foundry, ABI parity, TypeScript test, dual RPC, explorer, dan source contract.

## Kepatuhan produk XYX

Workflow Jev internal ini terpisah dari Jev Evidence Assessment produk yang didefinisikan di PRD bagian 6.5.1. Keduanya tetap advisory, real-only, server-side, dan tidak memiliki authority settlement. Integrasi produk tidak boleh dimulai sebelum P0 mempunyai bukti live yang dapat diperiksa.
