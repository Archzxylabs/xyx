# XYX — PRD Monad Testnet

**Versi:** 2.0 draft implementasi, 19 September 2026
**Status:** acuan produk dan kriteria penerimaan; item bertanda **Gap** belum selesai
**Lingkungan:** Monad Testnet saja

Audit kode, keputusan produk/infra, dan backlog rinci ada di [XYX_MONAD_BLUEPRINT.md](XYX_MONAD_BLUEPRINT.md). Hasil pengecekan lokal terbaru tercatat pada bagian 16 dokumen tersebut; target rancangan tidak berarti sudah terimplementasi.

## 1. Produk dan masalah

XYX adalah lapisan pembayaran bersyarat untuk pekerjaan agen. Buyer mengunci hadiah dalam escrow. Provider mengerjakan instruksi yang disepakati. Verifier memeriksa bukti, lalu evaluator memberi keputusan bertanda tangan. Kontrak membayar provider jika syarat terpenuhi, atau mengembalikan hadiah kepada buyer jika hasil ditolak atau job kedaluwarsa.

Masalah yang dituju: hash transaksi atau klaim agen bahwa tugas selesai tidak membuktikan hasilnya cocok dengan pesanan. Pembayaran di muka berisiko bagi buyer; pembayaran setelah kerja berisiko bagi provider. XYX harus mengikat instruksi, bukti, keputusan, dan perpindahan dana pada satu job yang bisa diaudit.

**Kasus pertama:** buyer memberi provider tugas mengirim 0,01 USDC pada Monad Testnet dari alamat provider ke recipient yang ditetapkan. Buyer mengunci hadiah 0,02 USDC. Nominal ini hanya parameter demo, bukan harga produk. Tugas ini dipilih karena hasilnya dapat diperiksa melalui transaksi dan event ERC-20; P0 belum menilai kualitas pekerjaan agen yang subjektif.

**Janji P0:** jika bukti yang tersedia cocok dengan syarat job, hadiah dibayar; jika bukti lengkap menunjukkan mismatch, hadiah di-refund; jika job tidak selesai saat expiry, refund dapat diklaim. Kontrak tidak membaca IPFS atau receipt secara langsung. Keputusan attestor tetap asumsi kepercayaan, dan evidence harus memungkinkan audit independen.

## 2. Pengguna, peran, dan hak

| Peran | Tindakan | Kepentingan |
| --- | --- | --- |
| Buyer | Menentukan tugas, membuat job, menyetujui allowance, mendanai escrow | Hasil sesuai instruksi atau hadiah kembali |
| Provider | Menyetel budget dalam alur demo, mengirim USDC, menyerahkan hash transaksi | Dibayar jika tugas valid |
| Attestor | Menjalankan verifikasi dan menandatangani verdict EIP-712 | Keputusan yang dapat dipertanggungjawabkan |
| Relayer | Mengirim verdict ke chain; dapat memanggil refund expiry | Membayar gas tanpa dapat mengubah verdict |
| Admin | Mengelola role evaluator | Membatasi dan mencabut otoritas attestor |
| Pauser | Menghentikan verdict baru ketika ada masalah | Respons insiden |
| Penonton/juri | Membaca UI, IPFS, dan explorer | Dapat menguji klaim demo tanpa kunci privat |

Buyer, provider, attestor, dan relayer wajib memakai empat alamat berbeda. Deployer, admin, dan pauser dicatat terpisah saat deployment. Recipient dapat merupakan alamat kelima. Tidak satu pun private key boleh masuk Git, browser, IPFS, log publik, atau file run.

## 3. Tujuan, ukuran sukses, dan batas P0

### Tujuan

1. Instruksi yang disetujui buyer tidak berubah diam-diam setelah job dibuat.
2. Hadiah benar-benar berada di escrow sebelum provider bekerja.
3. Pemeriksaan transfer mencakup chain, token, pengirim, recipient, jumlah, status transaksi, dan job.
4. Job memiliki satu hasil final: `Completed`, `Rejected`, atau `Expired`, dengan satu perpindahan hadiah yang benar.
5. Orang lain dapat menelusuri job, spesifikasi, evidence, verdict, dan settlement.

### Ukuran penerimaan demo

- Tiga job testnet **berbeda** menghasilkan sukses, penolakan karena transfer salah, dan refund expiry.
- Masing-masing memiliki receipt, status final on-chain, serta bukti perpindahan USDC yang dapat dibuka publik.
- Halaman `/demo` jujur menampilkan kosong atau `UNVERIFIED` sampai chain dan storage terbaca. Fixture lokal tidak pernah disebut live.
- Juri dapat memeriksa data tanpa menjalankan wallet operator.

### Batas

Hanya Monad Testnet dan satu jenis tugas payout USDC. Tidak ada marketplace terbuka, banyak token, fee, hooks, upgrade proxy, dispute manusia, HTTP outcome, x402, subgraph, registri identitas proprietary, reputasi, atau deployment mainnet pada P0. Provider diidentifikasi dari alamat penanda tangan transaksi. ERC-8004 dapat diteliti kemudian setelah kebutuhan dan deployment Monad yang dipilih diverifikasi. Implementasi escrow P0 minimal, bukan kontrak referensi upgradeable ERC-8183; lihat [draft ERC-8183](https://eips.ethereum.org/EIPS/eip-8183).

Dokumen lama dalam `docs/archive/` hanya sejarah. Tidak ada data atau alamat jaringan lama yang dibawa ke deployment baru.

## 4. Jaringan dan dependensi yang harus diverifikasi

| Komponen | Konfigurasi P0 | Preflight wajib |
| --- | --- | --- |
| Chain | Monad Testnet, chain ID `10143` | Baca `eth_chainId` dari RPC yang digunakan |
| Gas | MON | Cek saldo tiap wallet dan gas limit tiap aksi |
| USDC testnet | Kandidat `0x534b2f3A21130d7a60830c2Df862319e593943A3` | Cocokkan dokumentasi resmi terbaru, bytecode, identitas token, `decimals() = 6` |
| RPC | Endpoint Monad Testnet yang dikonfigurasi | Cek chain ID, kode kontrak, job, transaksi, dan receipt |
| Storage | Kubo lokal atau Pinata publik | Tulis JSON, baca ulang byte yang sama, cocokkan hash |
| Explorer | MonadVision Testnet | Pastikan hash dan alamat membuka data pada chain yang sama |

Sumber resmi: [Monad Testnet](https://docs.monad.xyz/developer-essentials/testnet), [panduan USDC testnet](https://docs.monad.xyz/guides/x402), dan [gas pricing Monad](https://docs.monad.xyz/developer-essentials/gas-pricing). Fakta yang dapat berubah harus dicek ulang sebelum broadcast. Dokumentasi resmi menyatakan Monad mengenakan biaya berdasarkan **gas limit**, sehingga operator tidak boleh menaikkan limit sembarangan. MON dan USDC testnet dapat disiapkan lewat faucet yang dirujuk dokumentasi; faucet bukan bagian dari runtime produk.

## 5. Arsitektur dan batas kepercayaan

```text
Buyer ─create/fund─> AgenticCommerce <─submit hash─ Provider
                         │  job state + escrow          │
                         │                              └─USDC.transfer─> Recipient
                         ▲
                         │ complete/reject
                    XYXEvaluator <─verdict + signature─ Relayer
                         ▲
                         │ EIP-712 signature
                      Attestor <─ evidence ─ Verifier ─ RPC + IPFS

Penonton ─> /demo ─> RPC + manifest run + IPFS + explorer
```

`AgenticCommerce` memegang dana dan status. `XYXEvaluator` memeriksa role, tanda tangan, waktu, nonce, dan replay verdict, lalu memanggil settlement. Verifier off-chain membaca fakta dan menulis evidence. IPFS menyimpan byte spesifikasi/evidence; hash on-chain dan dalam manifest dipakai untuk mendeteksi perubahan. Attestor adalah pihak tepercaya: kontrak tidak dapat menjamin attestor membaca receipt yang benar. Pemisahan attestor dan relayer mengurangi risiko satu kunci, tetapi tidak membuat verifikasi trustless.

## 6. Alur end to end

### 6.1 Persiapan sebelum ada job

1. Build dan uji source; catat commit, versi compiler, dan artefak kontrak.
2. Siapkan RPC dan baca chain ID. Verifikasi token USDC testnet, desimal, serta kode kontraknya.
3. Siapkan deployer, admin, pauser, buyer, provider, attestor, relayer. Cek alamat operasional berbeda; cek saldo MON untuk semua pengirim transaksi dan USDC buyer/provider.
4. Siapkan Kubo/Pinata. Lakukan uji tulis → baca ulang → hash sama. Jika storage tidak tersedia, jangan mulai alur verdict.
5. Deploy `AgenticCommerce(token)`, lalu `XYXEvaluator(admin, attestor, pauser, commerce, maxVerdictLifetime)`. Deployment script menolak chain selain 10143. Catat alamat, transaction hash, block, constructor args, verified source, `paymentToken`, `agenticCommerce`, dan role attestor. Jangan mengklaim deployment hanya dari output simulasi Foundry.

### 6.2 Membuat spesifikasi

Buyer dan provider menyepakati recipient, provider, jumlah tugas, hadiah, serta expiry. Operator membuat `PayoutSpec` versi `xyx.payout.v1`, mengubahnya ke JSON kanonis, menyimpan ke IPFS, membaca ulang, lalu menghitung `specHash = keccak256(bytes(canonicalJSON(spec)))`. Deskripsi job on-chain berisi `kind`, `specHash`, dan `specURI`. Jika ada perubahan instruksi, buat job baru; jangan mengedit interpretasi hash lama.

### 6.3 Membuat dan mendanai job

1. Buyer memanggil `createJob(provider, evaluator, expiresAt, description, hook=0)`. Terbit `JobCreated`, status `Open`, dan `jobId` baru. Belum ada dana terkunci.
2. Provider dalam alur demo memanggil `setBudget(jobId, rewardAtomic, emptyOptParams)`. Implementasi kontrak juga mengizinkan buyer melakukan ini saat `Open`. Budget masih dapat diubah saat `Open`, lalu tidak dapat diubah sesudah funding.
3. Buyer melakukan `USDC.approve(commerce, rewardAtomic)` jika allowance kurang.
4. Buyer memanggil `fund(jobId, expectedBudget, emptyOptParams)` sebelum expiry. Kontrak mengambil hadiah dari buyer. Status menjadi `Funded`. Receipt approval saja tidak boleh ditampilkan sebagai funding.
5. Provider baru melaksanakan tugas setelah receipt funding sukses dan `getJob` menunjukkan budget/status yang disepakati.

### 6.4 Melaksanakan dan menyerahkan tugas

Provider mengirim `USDC.transfer(recipient, amountAtomic)` dari alamat provider. Setelah receipt tersedia, provider memanggil `submit(jobId, transferTxHash, emptyOptParams)` sebelum expiry. Kontrak menyimpan hash dalam `deliverables(jobId)` dan status menjadi `Submitted`. Kontrak belum menilai apakah transfer itu benar.

Hardening terbaru juga menyimpan block funding/submission dan mereservasi hash per provider per deployment. Verifier P0 mensyaratkan operasi berada pada block terpisah: funding < transfer < submission. CLI/provider harus mengikuti urutan ini; hash tetap terpakai sesudah job rejected/expired.

### 6.5 Verifikasi, verdict, dan settlement

Verifier membaca deskripsi on-chain, spesifikasi IPFS, job, deliverable, transaksi, dan receipt. Hasil hanya boleh:

- `COMPLETE`: semua sumber tersedia dan seluruh syarat cocok.
- `REJECT`: sumber tersedia dan lengkap, tetapi mismatch nyata ditemukan, misalnya recipient salah.
- `UNVERIFIED`: RPC/IPFS tidak tersedia, receipt belum ada/stabil, data tidak konsisten, atau job tidak memenuhi prasyarat. Ini **bukan** penolakan provider.

Verifier menyimpan evidence kanonis dan melakukan readback. Attestor menandatangani `JobVerdict` EIP-712 dengan evidence hash, reason hash, decision, waktu terbit/akhir, dan nonce. Relayer memanggil `resolveJob`. Evaluator memeriksa role, domain, waktu, nonce/digest, dan pause. Keputusan `1` memanggil `complete`; keputusan `2` memanggil `reject`. Settlement terjadi dalam transaksi verdict yang sama; jika panggilan escrow revert, keseluruhan transaksi revert.

### 6.6 Hasil akhir dan refund

`Completed`: escrow mengirim hadiah ke provider. `Rejected`: escrow mengembalikan hadiah ke buyer. `Expired`: setelah `expiredAt`, siapa pun dapat memanggil `claimRefund` untuk job `Funded` atau `Submitted`; buyer menerima hadiah kembali tanpa verdict attestor. UI wajib memeriksa status final serta log transfer hadiah, bukan hanya field `decision` di file lokal.

## 7. State machine kontrak

| Awal | Aksi | Aktor yang diterima kontrak saat ini | Syarat | Akhir dan perpindahan dana |
| --- | --- | --- | --- | --- |
| Belum ada | `createJob` | Pemanggil menjadi buyer | Provider/evaluator valid, expiry masa depan, description ada, hook nol | `Open`; dana belum masuk |
| `Open` | `setBudget` | Buyer atau provider | Amount positif, params kosong | Tetap `Open`; budget tersimpan |
| `Open` | `fund` | Buyer | Sebelum expiry, expected budget cocok, allowance cukup | `Funded`; buyer → escrow |
| `Funded` | `submit` | Provider | Sebelum expiry, hash nonzero | `Submitted`; deliverable tersimpan |
| `Submitted` | `complete` | Evaluator job | Sebelum expiry | `Completed`; escrow → provider |
| `Open` | `reject` | Buyer | Params kosong | `Rejected`; tidak ada refund |
| `Funded` atau `Submitted` | `reject` | Evaluator job | Params kosong | `Rejected`; escrow → buyer |
| `Funded` atau `Submitted` | `claimRefund` | Siapa pun | Waktu chain melewati expiry | `Expired`; escrow → buyer |

Status final tidak bisa diubah dan hadiah tidak boleh keluar dua kali. Escrow menggunakan SafeERC20 dan ReentrancyGuard pada jalur dana. Evaluator menolak signer tanpa role, keputusan tidak dikenal, hash kosong, verdict basi, nonce/digest ulang, dan domain tanda tangan yang salah. Pause evaluator menghentikan verdict baru, tetapi tidak menghentikan refund expiry pada escrow. Mapping nonce tumbuh terus; ini diterima untuk pilot dan bukan mekanisme produksi tanpa peninjauan biaya storage.

## 8. Kontrak data

### 8.1 Spesifikasi tugas

```json
{
  "kind": "xyx.payout.v1",
  "chainId": 10143,
  "commerce": "0x...",
  "buyer": "0x...",
  "provider": "0x...",
  "token": "0x...",
  "recipient": "0x...",
  "amountAtomic": "10000",
  "rewardAtomic": "20000",
  "expiresAt": 2000000000
}
```

`amountAtomic` dan `rewardAtomic` adalah string integer positif. Dengan enam desimal, `10000` = 0,01 USDC dan `20000` = 0,02 USDC. `expiresAt` adalah detik Unix. Schema menolak field tambahan. Alamat divalidasi bentuknya lalu dibandingkan tanpa membedakan kapitalisasi. `kind` dan chain ID mengikat versi protokol; versi baru harus memakai `kind` baru.

### 8.2 Komitmen, bukti, dan verdict

- `canonicalJSON` menyortir key object secara rekursif; Keccak-256 dihitung atas byte UTF-8 hasilnya.
- Description on-chain adalah JSON kanonis `{kind, specHash, specURI}`; URI memakai `ipfs://<CID>`.
- Deliverable adalah `bytes32` hash transaksi transfer.
- Evidence berisi `specHash`, `transferHash`, nilai expected, nilai observed, `decision`, dan daftar failure code. Bundle yang dipersist juga mencatat `jobId`, `commerce`, `evaluator`, `specURI`.
- `evidenceHash` adalah hash byte JSON kanonis yang dibaca ulang dari IPFS. `reasonHash` saat ini adalah hash JSON kanonis daftar failure code. Event verdict membawa hash, keputusan, dan attestor; URI evidence berada pada manifest/run record off-chain.
- Domain EIP-712: name `XYX Evaluator`, version `1`, chain ID `10143`, verifying contract = evaluator. Payload: `jobId`, `evidenceHash`, `reasonHash`, `decision`, `issuedAt`, `expiresAt`, `nonce`.

File run lokal hanya catatan operasi, bukan sumber kebenaran. Klaim publik harus cocok dengan chain dan byte IPFS. Jika schema berubah, versi harus dinaikkan; evidence lama tidak boleh ditafsirkan memakai aturan baru tanpa migrasi eksplisit.

## 9. Aturan pemeriksaan payout

### Sudah ada dalam kode

1. RPC mengembalikan chain ID 10143.
2. Description job kanonis dan `specHash` cocok dengan spec.
3. Buyer, provider, budget, dan expiry job cocok dengan spec.
4. Command evaluasi hanya berjalan ketika status `Submitted`; pembacaan ulang UI boleh saat `Completed` atau `Rejected`.
5. Hash deliverable on-chain sama dengan transfer hash yang akan diperiksa.
6. Transaksi dan receipt dapat dibaca; receipt harus sukses.
7. `transaction.from` = provider; target transaksi/receipt = alamat token yang disepakati.
8. Calldata tepat `transfer(recipient, amount)` dan tepat satu log `Transfer` dari token yang sama berisi `from=provider`, `to=recipient`, `value=amountAtomic`.
9. Evaluator job cocok dengan deployment evaluator dan attestor masih memiliki role.
10. Receipt cocok dengan transaksi dan block kanonis yang telah finalized; block submission juga sudah finalized.
11. Block transfer berada sesudah funding dan sebelum submission; timestamp transfer sebelum expiry; reservasi deliverable cocok dengan provider/job. Pembacaan seluruh state pada satu snapshot finalized dan pembandingan dua RPC masih perlu dilengkapi.

Mismatch yang **teramati** menghasilkan failure code dan `REJECT`. RPC/IPFS gagal, spesifikasi tidak konsisten, atau receipt tidak tersedia harus menghentikan signing sebagai `UNVERIFIED`.

### Status gap setelah audit lokal

**Gap A — transfer lama dan replay lintas job: mitigasi lokal ditambahkan.** Verifier memeriksa urutan block/waktu; escrow menyimpan reservasi `deliverableJob[provider][hash]` yang tidak dilepas setelah status final. Verifier/publisher/UI kini mengambil snapshot finalized pada block yang sama dari dua RPC dan menolak state/receipt yang berbeda. Tes lokal mencakup transfer lama, reuse lintas job/provider, dan disagreement RPC. Proteksi ini terbatas pada satu deployment escrow, bukan replay universal. Deployment baru dan pembuktian live tetap diperlukan.

**Gap B — transaksi dengan banyak transfer: policy lokal dipersempit.** P0 hanya menerima direct transfer dengan calldata tepat dan satu log Transfer token yang cocok; beberapa Transfer tidak diterima. Evidence memakai versi `xyx.payout.evidence.v2`. Token dengan fee/rebase tidak didukung dan identitas USDC harus diverifikasi sebelum demo.

**Gap C — bukti publik portabel: implementasi lokal ditambahkan.** `publish-manifest.ts` membangun manifest ketat tanpa secret, memverifikasi kembali spec/evidence/settlement pada chain finalized, lalu mengunggahnya ke IPFS. `/demo` hanya membaca manifest publik, gateway IPFS tanpa credential upload, dan RPC. Manifest/live URI belum ada sebelum tiga run nyata dibuat.

**Gap D — klaim settlement UI: implementasi lokal ditambahkan.** Label `LIVE VERIFIED` sekarang mensyaratkan receipt finalized, event dari evaluator dan escrow yang tepat, serta satu log Transfer USDC escrow → provider/buyer sebesar budget. Tes lokal mencakup sukses, reject, expiry, emitter palsu, dan transfer settlement salah. Receipt/live evidence publik tetap menjadi gate demo.

Pembuktian live dan ketersediaan manifest dari perangkat lain masih terbuka. Selain itu, transfer payout provider tidak dapat dibatalkan dan reward dapat kembali ke buyer jika attestor terlambat sampai expiry. Klaim proteksi harus mengungkap batas ekonomi serta trust ini; lihat blueprint bagian 4.

## 10. Tiga skenario demo nyata

### A. Sukses

Job baru: buyer mendanai 0,02 USDC. Provider mengirim 0,01 USDC ke recipient yang disepakati lalu submit hash. Evidence menunjukkan expected = observed, tanpa failure code. Verdict `COMPLETE` membuat job `Completed`. Receipt settlement dan log USDC membuktikan escrow mengirim 0,02 USDC ke provider.

### B. Transfer salah

Job **baru**: buyer mendanai 0,02 USDC. Provider sengaja mentransfer 0,01 USDC ke alamat selain recipient yang disepakati lalu submit hash. Receipt transfer tetap sukses, tetapi evidence memuat `TRANSFER_MISMATCH`. Verdict `REJECT` membuat job `Rejected` dan escrow mengembalikan 0,02 USDC ke buyer. Dana 0,01 USDC yang dikirim provider ke alamat salah **tidak dibatalkan**; UI harus menjelaskan konsekuensi ini.

### C. Kedaluwarsa

Job baru didanai, lalu tidak diselesaikan. Setelah expiry menurut waktu chain, relayer memanggil `claimRefund`. Job menjadi `Expired`, escrow mengembalikan 0,02 USDC ke buyer, dan tidak ada verdict attestor. Default durasi persiapan 900 detik; `MONAD_DEMO_EXPIRY_SECONDS` dapat diatur 300–86400 detik. Jangan mengklaim expiry dari jam lokal saja.

Untuk tiap skenario, simpan chain ID, alamat token/kontrak, job ID, spec URI/hash, seluruh hash transaksi yang benar-benar dikirim, receipt sukses, block, status final, deliverable jika ada, evidence URI/hash jika ada, event verdict jika ada, serta log perpindahan USDC. Tiga kasus tidak boleh memakai job atau transfer yang sama.

## 11. Halaman `/demo` dan pengalaman juri

1. Jelaskan nilai produk dalam satu kalimat dan tampilkan langkah commit → fund/execute → verify → settle.
2. Tampilkan tiga kartu dengan label yang jelas: `LIVE VERIFIED`, `PENDING`, `UNVERIFIED`, atau `CONFLICT`. `LIVE VERIFIED` memerlukan semua receipt, state, hash, dan log settlement yang cocok.
3. Tiap kartu menampilkan expected vs observed: sender, token, recipient, jumlah, status receipt, failure code, dan alasan keputusan dalam bahasa biasa.
4. Tampilkan job ID, status final, alamat kontrak, expiry, spec/evidence hash dan URI, serta tautan explorer untuk create, fund, transfer, submit, verdict, dan refund yang tersedia.
5. Jelaskan bahwa attestor menandatangani keputusan; jangan memberi kesan kontrak membaca IPFS sendiri.
6. Bila RPC/IPFS gagal, receipt hilang, atau manifest tidak cocok dengan chain, turunkan label menjadi `UNVERIFIED` atau `CONFLICT`; jangan mempertahankan hasil sukses lama.
7. Tanpa run live, tampilkan empty state. Fixture dan transaksi yang baru disiapkan tidak boleh terlihat sebagai kejadian nyata.

UI saat ini baca-only dan mengandalkan file run lokal. Daftar di atas adalah target penerimaan, bukan klaim bahwa seluruhnya sudah ada.

## 12. Kegagalan dan pemulihan

| Kejadian | Respons produk | Tindakan operator |
| --- | --- | --- |
| Chain ID/RPC salah | Tidak broadcast | Ganti RPC, ulang preflight |
| Token/kode kontrak salah | Tidak fund | Verifikasi bytecode, decimals, binding deployment |
| MON, USDC, atau allowance kurang | Tidak klaim langkah berikutnya | Danai wallet yang tepat; cek ulang receipt/state |
| IPFS tulis/readback gagal | Tidak sign verdict | Pulihkan storage lalu ulang verifikasi |
| Receipt transfer belum ditemukan | `UNVERIFIED`, bukan `REJECT` | Tunggu atau cek RPC kedua |
| Transfer lengkap tetapi salah | `REJECT` dengan failure code | Periksa observed dan persetujuan attestor |
| Broadcast berhasil tetapi command timeout | Jangan broadcast ulang buta | Rekonsiliasi hash, nonce, receipt, event, dan job |
| Verdict basi atau job expired | Verdict basi/COMPLETE setelah expiry revert; REJECT saat ini masih dapat refund setelah expiry | Aplikasi memakai claimRefund setelah expiry; dokumentasikan pilihan label terminal |
| Attestor dikompromi | Risiko verdict palsu | Pause, cabut role, audit job/evidence |
| File run hilang | UI tidak dapat menemukan run | Rekonstruksi manifest dari event/receipt yang diverifikasi |

Gas limit perlu diukur dan dibatasi karena Monad mengenakan biaya menurut limit. Catatan operasi tidak boleh menyimpan kunci. Refund expiry tetap tersedia meskipun evaluator di-pause.

## 13. Keamanan dan model ancaman

- **Spec diubah:** cocokkan byte IPFS dan hash terhadap description on-chain; cek buyer/job.
- **Hash transaksi orang lain:** cocokkan `transaction.from` dan `Transfer.from` dengan provider.
- **Token, penerima, atau jumlah salah:** cocokkan target transaksi, alamat log, `to`, dan `value` tepat.
- **RPC keliru:** ulangi pemeriksaan melalui explorer atau RPC kedua sebelum demo publik; RPC tunggal adalah asumsi kepercayaan operasional.
- **Transfer lama/replay:** mitigasi block dan reservasi hash telah ditambahkan untuk satu deployment; lihat Gap A dan batas snapshot/live.
- **Replay verdict:** domain EIP-712 mengikat chain/kontrak; nonce dan digest dikonsumsi; waktu dibatasi.
- **Attestor salah/kolusi:** role dan pemisahan kunci tidak membuat keputusan trustless; evidence harus bisa diaudit publik.
- **Double settlement/reentrancy:** status final, SafeERC20, dan ReentrancyGuard harus diuji secara adversarial; audit independen diperlukan sebelum nilai nyata.
- **Kebocoran kunci:** private key hanya di environment lokal/secret manager; jangan masuk browser, Git, run file, atau IPFS.

## 14. Kriteria penerimaan dan tes

### Kontrak

- Foundry membuktikan sukses membayar provider sekali; reject/refund membayar buyer sekali; expiry mengembalikan dana; status final tidak dapat diubah.
- Tes mencakup aktor salah, signer salah, domain chain/contract salah, nonce ulang, verdict basi, pause, boundary expiry, dan transfer token yang revert.
- Deploy script menolak chain yang salah dan input kosong; deployment live harus dibuktikan dari receipt serta kode on-chain.

### Verifier dan storage

- Unit test mencakup transfer tepat, recipient/jumlah/token/sender salah, receipt revert, log palsu, spec/job salah, serta RPC/IPFS gagal.
- Test transfer lama dan replay lintas job harus lulus sebelum Gap A dianggap selesai.
- Byte JSON yang sama menghasilkan hash sama; byte readback IPFS cocok dengan byte yang di-hash.
- Hanya mismatch yang terbukti menghasilkan `REJECT`; kegagalan memperoleh data menghasilkan `UNVERIFIED`.

### End to end

- Setelah perubahan kode relevan jalankan `npm run test:contracts`, `npm test`, `npm run typecheck`, dan `npm run build:web`.
- Tiga job testnet berbeda mempunyai receipt, state akhir, dan log perpindahan USDC yang cocok.
- Juri dapat membuka manifest, IPFS, dan semua transaksi tanpa kunci operator.
- UI tetap jujur saat RPC/IPFS mati atau run belum ada.
- Tidak ada klaim deployment sebelum alamat, receipt sukses, block, dan source terverifikasi dicatat.

**Definition of done P0:** seluruh kriteria di atas lulus, Gap A dan D ditutup atau klaim publik dipersempit secara tegas, dan tiga run live bisa diperiksa mandiri. Unit test lokal saja tidak cukup.

## 15. Status implementasi saat dokumen ini ditulis

| Area | Sudah ada di repo | Belum dibuktikan atau belum selesai |
| --- | --- | --- |
| Escrow/evaluator | Kontrak, deploy script, tes lifecycle lokal | Deployment Monad Testnet dan audit independen belum tercatat |
| Spec/IPFS | Schema, canonical hash, Kubo/Pinata write-readback | Ketersediaan publik evidence belum dibuktikan |
| Verifier | Cek chain/job, direct calldata/log, block/waktu, finality, binding/reservasi hash, dan snapshot dua RPC | Bukti deployment/live belum selesai |
| CLI | `prepare`, `create`, `budget`, `fund`, `execute`, `evaluate`, `refund`, `inspect` | Rekonsiliasi broadcast ambigu masih manual; live run belum diasumsikan |
| Web `/demo` | Baca manifest publik, spec/evidence IPFS, snapshot finalized, verdict/settlement dan log USDC | Manifest/live URI, cross-RPC, dan UX job detail belum selesai |
| Skenario demo | Langkah dan command didefinisikan | Tiga receipt hasil live belum tercatat di repo |

Tabel status harus diperbarui dari bukti baru, bukan dari rencana atau fixture.

## 16. Urutan pengerjaan berikutnya

1. Lengkapi tes negatif kontrak untuk token gagal, verifier/domain/nonce/role, dan pemulihan broadcast ambigu.
2. Verifikasi ulang fakta Monad, token, gas, IPFS, alamat, dan role; deploy, verifikasi source, catat receipt serta block.
3. Jalankan tiga job live, audit melalui explorer/RPC kedua, publish manifest, lalu buka `/demo` dari perangkat tanpa credential operator.
4. Setelah demo terbukti, bangun runner/SDK agen dan worker/DB secara bertahap sesuai blueprint.

Tidak satu pun item dianggap selesai hanya karena PRD ini sudah ditulis.
