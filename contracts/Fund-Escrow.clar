;; Fund-Escrow.clar
;; Core smart contract for managing escrowed funds in aid campaigns.
;; Handles funding from NFT sales, milestone verifications, and conditional releases.
;; Integrates with Outcome-Oracle for verifications and Project-Registry for project details.

;; Constants
(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-PROJECT-NOT-EXIST (err u101))
(define-constant ERR-MILESTONE-NOT-VERIFIED (err u102))
(define-constant ERR-INSUFFICIENT-FUNDS (err u103))
(define-constant ERR-ALREADY-RELEASED (err u104))
(define-constant ERR-PAUSED (err u105))
(define-constant ERR-INVALID-AMOUNT (err u106))
(define-constant ERR-INVALID-RECIPIENT (err u107))
(define-constant ERR-MAX-MILESTONES-REACHED (err u108))
(define-constant ERR-INVALID-MILESTONE-INDEX (err u109))
(define-constant ERR-REFUND-NOT-ALLOWED (err u110))
(define-constant ERR-CONTRACT-NOT-INITIALIZED (err u111))
(define-constant ERR-ALREADY-INITIALIZED (err u112))
(define-constant ERR-INVALID-PERCENTAGE (err u113))
(define-constant MAX-MILESTONES u10)
(define-constant REFUND_GRACE_PERIOD u144) ;; ~1 day in blocks

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var total-escrowed uint u0)
(define-data-var initialized bool false)

;; Data Maps
(define-map project-escrows
  principal ;; project-id (principal from Project-Registry)
  {
    total-funded: uint,
    released: uint,
    milestones-count: uint,
    active: bool,
    refund-window-start: (optional uint),
    recipient: principal ;; aid recipient or project admin
  }
)

(define-map milestones
  { project-id: principal, milestone-index: uint }
  {
    description: (string-utf8 256),
    target-amount: uint,
    verified: bool,
    release-percentage: uint, ;; 0-100
    verifier: (optional principal),
    verification-timestamp: (optional uint)
  }
)

(define-map fund-contributions
  { project-id: principal, contributor: principal }
  {
    amount: uint,
    timestamp: uint,
    refunded: bool
  }
)

;; Private Functions
(define-private (is-contract-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (is-project-active (project-id principal))
  (match (map-get? project-escrows project-id)
    escrow (get active escrow)
    false
  )
)

(define-private (calculate-release-amount (project-id principal) (milestone-index uint))
  (let
    (
      (project (unwrap! (map-get? project-escrows project-id) ERR-PROJECT-NOT-EXIST))
      (milestone (unwrap! (map-get? milestones {project-id: project-id, milestone-index: milestone-index}) ERR-INVALID-MILESTONE-INDEX))
      (total-funded (get total-funded project))
      (percentage (get release-percentage milestone))
    )
    (/ (* total-funded percentage) u100)
  )
)

;; Public Functions

;; Initialize the contract (called once by deployer)
(define-public (initialize (recipient principal))
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get initialized)) ERR-ALREADY-INITIALIZED)
    (var-set initialized true)
    (ok true)
  )
)

;; Pause the contract (admin only)
(define-public (pause)
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED)
    (var-set paused true)
    (ok true)
  )
)

;; Unpause the contract (admin only)
(define-public (unpause)
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED)
    (var-set paused false)
    (ok true)
  )
)

;; Create escrow for a new project (called by Project-Registry)
(define-public (create-project-escrow (project-id principal) (recipient principal) (initial-milestones (list 10 {description: (string-utf8 256), target-amount: uint, release-percentage: uint})))
  (begin
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED) ;; Assuming Project-Registry is owner or authorized
    (asserts! (is-none (map-get? project-escrows project-id)) ERR-PROJECT-NOT-EXIST) ;; Should not exist
    (asserts! (<= (len initial-milestones) MAX-MILESTONES) ERR-MAX-MILESTONES-REACHED)
    (map-set project-escrows project-id
      {
        total-funded: u0,
        released: u0,
        milestones-count: (len initial-milestones),
        active: true,
        refund-window-start: none,
        recipient: recipient
      }
    )
    (fold set-initial-milestone initial-milestones {project-id: project-id, index: u0})
    (ok true)
  )
)

;; Helper fold function for setting initial milestones
(define-private (set-initial-milestone (ms {description: (string-utf8 256), target-amount: uint, release-percentage: uint}) (state {project-id: principal, index: uint}))
  (let
    (
      (project-id (get project-id state))
      (index (get index state))
    )
    (asserts! (<= (get release-percentage ms) u100) ERR-INVALID-PERCENTAGE)
    (map-set milestones {project-id: project-id, milestone-index: index}
      {
        description: (get description ms),
        target-amount: (get target-amount ms),
        verified: false,
        release-percentage: (get release-percentage ms),
        verifier: none,
        verification-timestamp: none
      }
    )
    {project-id: project-id, index: (+ index u1)}
  )
)

;; Fund the escrow (from NFT sales)
(define-public (fund-escrow (project-id principal) (amount uint))
  (begin
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (is-project-active project-id) ERR-PROJECT-NOT-EXIST)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (let
      (
        (project (unwrap! (map-get? project-escrows project-id) ERR-PROJECT-NOT-EXIST))
        (new-total (+ (get total-funded project) amount))
        (contrib (default-to {amount: u0, timestamp: u0, refunded: false} (map-get? fund-contributions {project-id: project-id, contributor: tx-sender})))
      )
      (map-set project-escrows project-id (merge project {total-funded: new-total}))
      (map-set fund-contributions {project-id: project-id, contributor: tx-sender}
        {
          amount: (+ (get amount contrib) amount),
          timestamp: block-height,
          refunded: false
        }
      )
      (var-set total-escrowed (+ (var-get total-escrowed) amount))
      (print {event: "fund-added", project-id: project-id, amount: amount, contributor: tx-sender})
      (ok true)
    )
  )
)

;; Verify and release for a milestone (called by Outcome-Oracle)
(define-public (verify-and-release (project-id principal) (milestone-index uint) (verifier principal))
  (begin
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED) ;; Assume Oracle is authorized
    (asserts! (is-project-active project-id) ERR-PROJECT-NOT-EXIST)
    (let
      (
        (project (unwrap! (map-get? project-escrows project-id) ERR-PROJECT-NOT-EXIST))
        (milestone (unwrap! (map-get? milestones {project-id: project-id, milestone-index: milestone-index}) ERR-INVALID-MILESTONE-INDEX))
      )
      (asserts! (not (get verified milestone)) ERR-ALREADY-RELEASED)
      (let
        (
          (release-amount (calculate-release-amount project-id milestone-index))
          (recipient (get recipient project))
          (new-released (+ (get released project) release-amount))
        )
        (asserts! (>= (as-contract (as-contract-get-balance)) release-amount) ERR-INSUFFICIENT-FUNDS)
        (map-set milestones {project-id: project-id, milestone-index: milestone-index}
          (merge milestone {verified: true, verifier: (some verifier), verification-timestamp: (some block-height)})
        )
        (map-set project-escrows project-id (merge project {released: new-released}))
        (try! (as-contract (stx-transfer? release-amount tx-sender recipient)))
        (print {event: "milestone-released", project-id: project-id, milestone-index: milestone-index, amount: release-amount})
        (ok true)
      )
    )
  )
)

;; Initiate refund window if project fails (admin only)
(define-public (initiate-refund-window (project-id principal))
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-NOT-AUTHORIZED)
    (let
      (
        (project (unwrap! (map-get? project-escrows project-id) ERR-PROJECT-NOT-EXIST))
      )
      (asserts! (is-project-active project-id) ERR-PROJECT-NOT-EXIST)
      (asserts! (is-none (get refund-window-start project)) ERR-REFUND-NOT-ALLOWED)
      (map-set project-escrows project-id (merge project {active: false, refund-window-start: (some block-height)}))
      (print {event: "refund-window-initiated", project-id: project-id})
      (ok true)
    )
  )
)

;; Claim refund (contributors only, during refund window)
(define-public (claim-refund (project-id principal))
  (begin
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (let
      (
        (project (unwrap! (map-get? project-escrows project-id) ERR-PROJECT-NOT-EXIST))
        (contrib (unwrap! (map-get? fund-contributions {project-id: project-id, contributor: tx-sender}) ERR-NOT-AUTHORIZED))
        (window-start (unwrap! (get refund-window-start project) ERR-REFUND-NOT-ALLOWED))
      )
      (asserts! (not (get active project)) ERR-REFUND-NOT-ALLOWED)
      (asserts! (< window-start (+ block-height REFUND_GRACE_PERIOD)) ERR-REFUND-NOT-ALLOWED)
      (asserts! (not (get refunded contrib)) ERR-ALREADY-RELEASED)
      (let
        (
          (refund-amount (get amount contrib))
        )
        (asserts! (>= (as-contract (as-contract-get-balance)) refund-amount) ERR-INSUFFICIENT-FUNDS)
        (map-set fund-contributions {project-id: project-id, contributor: tx-sender} (merge contrib {refunded: true}))
        (try! (as-contract (stx-transfer? refund-amount tx-sender tx-sender)))
        (print {event: "refund-claimed", project-id: project-id, amount: refund-amount, contributor: tx-sender})
        (ok true)
      )
    )
  )
)

;; Read-only Functions

(define-read-only (get-project-escrow (project-id principal))
  (map-get? project-escrows project-id)
)

(define-read-only (get-milestone (project-id principal) (milestone-index uint))
  (map-get? milestones {project-id: project-id, milestone-index: milestone-index})
)

(define-read-only (get-contribution (project-id principal) (contributor principal))
  (map-get? fund-contributions {project-id: project-id, contributor: contributor})
)

(define-read-only (get-total-escrowed)
  (var-get total-escrowed)
)

(define-read-only (get-contract-balance)
  (as-contract (stx-get-balance tx-sender))
)

(define-read-only (is-contract-paused)
  (var-get paused)
)