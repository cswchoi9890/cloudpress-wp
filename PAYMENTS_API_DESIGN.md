# CloudPress Payments REST API (Virtual Account)

가상계좌 입금 기반 자체 결제/정산 구조.

## Data Model

- `users`
- `products`
- `orders`
- `settlements`

## Fee Policy

- 플랫폼 수수료율: `platform_fee_rate` (기본 `0.20`)
- 계산식:
  - `gross_amount = unit_price * quantity`
  - `fee_amount = floor(gross_amount * fee_rate)`
  - `settlement_amount = gross_amount - fee_amount`

## Endpoints

### Products

- `GET /api/payments/products`
  - 공개/사용자 상품 목록 조회

- `POST /api/payments/products` (admin)
  - 상품 생성/수정
  - body:
    - `id?`, `name`, `description?`, `price`, `active?`

### Orders

- `POST /api/payments/orders` (user)
  - 주문 생성 + 가상계좌 안내 반환
  - body:
    - `product_id`, `quantity`
  - response:
    - `order`
    - `payment_guide` (bank/account/holder/memo)

- `GET /api/payments/orders` (user/admin)
  - 주문 목록 조회
  - query:
    - `status?`

### Payment Verify (Server required)

- `POST /api/payments/verify` (webhook/server)
  - 입금 검증 서버가 호출
  - body:
    - `order_id`, `tx_id`, `amount`, `depositor_name?`
  - headers:
    - `x-cp-ts`
    - `x-cp-signature` (HMAC-SHA256)
  - payload for signature:
    - `${ts}.${orderId}.${txId}.${amount}`
  - 성공 시:
    - `orders.status = paid`
    - `settlements` 생성

### Settlements

- `GET /api/payments/settlements` (user/admin)
  - 정산 목록 조회
  - query:
    - `status?`

- `PUT /api/payments/settlements` (admin)
  - 정산 상태 변경
  - body:
    - `id`, `status`, `note?`

## Operational Notes

- 결제 검증은 반드시 서버-서버 서명 검증을 사용
- 사용자 프론트엔드에서 직접 `paid` 상태를 변경하지 않음
- 사이트 생성 전 `orders.status='paid'` 확인 필수
