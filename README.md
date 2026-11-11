# Checkout Flow Demo

Demo checkout for an iPhone case merchant selling in Hong Kong and the Netherlands.

## What this demo includes

- Checkout.com Flow embedded on the merchant site
- One unified checkout mode:
  - `Open smart checkout`
- One method-by-method checkout mode:
  - `Show payment methods separately`
  - mounts Card, Apple Pay, PayPal, and AlipayHK individually when available
- Market-aware language choices:
  - Hong Kong: English or Chinese (Hong Kong) or Chinese(China)
  - Netherlands: English or Dutch
- Market-aware currency choices
- Optional 3DS-required session request
- Payment verification summary
- Webhook / order confirmation summary
- Partial or full refund request after capture
- Raw Checkout API logging with headers and bodies for requests and responses

This demo keeps sensitive card collection inside Checkout.com Flow instead of posting raw card details through the merchant backend.

That keeps the demo aligned with the requirement to collect payment details securely while keeping PCI scope lighter.

It also demonstrates:

- card checkout
- Apple Pay as an iPhone-friendly accelerated checkout option
- PayPal
- AlipayHK
- localization
- multi-currency processing
- optional 3DS initialization
- refund submission after capture

## Stack

- Node.js
- Express
- Plain HTML / CSS / JavaScript
- Checkout.com Flow / Web Components

## Project structure

```text
checkout-flow-demo-v3/
  .config.env
  server.js
  logs/
    checkout-api.log
  public/
    index.html
    app.js
    styles.css
```

## Checkout modes in the UI

### 1. Open smart checkout

Creates a payment session and mounts the single Flow experience:

- Checkout.com decides the presentation


### 2. Show payment methods separately

Creates a payment session and tries to mount these methods separately:

- Card
- Apple Pay
- PayPal
- AlipayHK

Each method card shows:

- `Mounted`
- `Unavailable`
- or `Error`

Availability still depends on:

- merchant/account enablement
- processing channel configuration
- market and currency
- device/browser support
- domain / Apple Pay setup


## Logging

Every Checkout API call is appended to:

```text
logs/checkout-api.log
```


## Sandbox and local testing notes
- Apple Pay on web usually requires:
  - HTTPS
  - supported Apple device/browser
  - account enablement
  - domain enrollment

So on localhost, Card is the most reliable path.
Apple Pay, PayPal, and AlipayHK may appear only when the current session is eligible.


## Reference docs used for the demo

- Accept a payment on your website
  https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-your-website

- Get started with Flow
  https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-your-website/get-started-with-flow

- Add localization to your Flow integration
  https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-your-website/add-localization-to-your-flow-integration

- 3D Secure
  https://www.checkout.com/docs/payments/authenticate-payments/3d-secure

- AlipayHK on web
  https://www.checkout.com/docs/payments/add-payment-methods/alipayhk/web

- PayPal on web
  https://www.checkout.com/docs/payments/add-payment-methods/paypal/web

- Refund a payment with a reference
  https://www.checkout.com/docs/payments/manage-payments/refund-a-payment/refund-a-payment-with-a-reference
