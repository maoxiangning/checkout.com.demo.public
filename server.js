import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { appendFile, mkdir, stat, writeFile } from "fs/promises";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: "./.config.env" });

const app = express();
const port = Number(process.env.PORT || 3000);

const allowedExact = new Set([
  "127.0.0.1",
  "::1",
  "34.250.245.3",
  "52.16.123.4",
  "52.211.205.187",
]);

const allowedCidrs = [
  "4.159.40.224/28",
  "135.116.97.64/28",
];

function ipToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isInCidr(ip, cidr) {
  const [range, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

app.use((req, res, next) => {
  const rawIp = req.ip || req.socket.remoteAddress || "";
  const ip = rawIp.replace("::ffff:", "");

  if (allowedExact.has(ip) || allowedCidrs.some((cidr) => isInCidr(ip, cidr))) {
    return next();
  }

  return res.status(403).send("Forbidden");
});


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, "logs");
const checkoutLogPath = path.join(logsDir, "checkout-api.log");

const requiredEnv = [
  "CHECKOUT_PUBLIC_KEY",
  "CHECKOUT_SECRET_KEY",
  "CHECKOUT_PROCESSING_CHANNEL_ID",
  "CHECKOUT_BASE_URL",
  "APP_BASE_URL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing env var: ${key}`);
  }
}

await mkdir(logsDir, { recursive: true });
try {
  const logStats = await stat(checkoutLogPath);
  if (logStats.size === 0) {
    await writeFile(
      checkoutLogPath,
      "# Checkout API raw request/response log. New entries are appended below.\n"
    );
  }
} catch {
  await writeFile(
    checkoutLogPath,
    "# Checkout API raw request/response log. New entries are appended below.\n"
  );
}

const currencies = {
  EUR: { code: "EUR", label: "Euro", locale: "en-IE" },
  HKD: { code: "HKD", label: "Hong Kong Dollar", locale: "zh-HK" },
  USD: { code: "USD", label: "US Dollar", locale: "en-US" },
};

const locales = [
  { code: "en", label: "English" },
  { code: "nl", label: "Dutch" },
  { code: "zh-hk", label: "Chinese (Hong Kong)" },
  { code: "zh", label: "Chinese (China)" },
];

const catalog = {
  case_01: {
    id: "case_01",
    name: "iPhone 18 Case",
    prices: { HKD: 22900, USD: 2990, EUR: 25900 },
  },
  case_02: {
    id: "case_02",
    name: "iPhone 18 Pro Case",
    prices: { HKD: 24900, USD: 3190, EUR: 27900 },
  },
  case_03: {
    id: "case_03",
    name: "iPhone Duo Case",
    prices: { HKD: 26900, USD: 3390, EUR: 29900},
  },
};

const markets = {
  HK: {
    code: "HK",
    label: "Hong Kong",
    country: "HK",
    defaultCurrency: "HKD",
    supportedCurrencies: ["HKD", "USD"],
    supportedLocales: ["en", "zh-hk", "zh"],
    defaultLocale: "zh",
  },
  NL: {
    code: "NL",
    label: "Netherlands",
    country: "NL",
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR", "USD"],
    supportedLocales: ["en", "nl"],
    defaultLocale: "nl",
  },
};

const orders = new Map();
const paymentToOrderRef = new Map();

function buildOrderRef(prefix = "CASE") {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;
}

function isValidSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signatureHeader, "utf8")
    );
  } catch {
    return false;
  }
}

function mapWebhookState(eventType) {
  switch (eventType) {
    case "payment_approved":
    case "payment_captured":
    case "card_verified":
      return "confirmed";
    case "payment_pending":
    case "payment_capture_pending":
      return "pending";
    case "payment_refunded":
      return "refunded";
    case "payment_declined":
    case "card_verification_declined":
    case "payment_capture_declined":
    case "payment_refund_declined":
    case "payment_canceled":
    case "payment_void_declined":
    case "payment_voided":
      return "failed";
    default:
      return "received";
  }
}

function mergeOrder(orderRef, patch) {
  const current = orders.get(orderRef) || { orderRef, refunds: [] };
  const next = {
    ...current,
    ...patch,
    refunds: patch.refunds || current.refunds || [],
    orderRef,
  };

  orders.set(orderRef, next);

  if (next.paymentId) {
    paymentToOrderRef.set(next.paymentId, orderRef);
  }

  return next;
}

function normalizeItems(items, currency) {
  return items
    .map((item) => {
      const product = catalog[item.id];
      const quantity = Number(item.quantity || 0);

      if (!product || quantity <= 0 || !product.prices[currency]) {
        return null;
      }

      return {
        reference: product.id,
        name: product.name,
        quantity,
        unit_price: product.prices[currency],
      };
    })
    .filter(Boolean);
}

function updateOrderFromPaymentDetails(orderRef, payment) {
  mergeOrder(orderRef, {
    paymentId: payment.id,
    paymentReference: payment.reference,
    gatewayStatus: payment.status,
    approved: payment.approved ?? null,
    paymentCheckedAt: new Date().toISOString(),
    paymentResult: payment,
    availableToRefund: payment?.balances?.available_to_refund ?? 0,
  });
}

function resolveMarket(marketCode) {
  return markets[marketCode] || null;
}

function resolveCurrency(selectedMarket, currencyCode) {
  if (!selectedMarket) return null;

  if (!currencyCode) {
    return selectedMarket.defaultCurrency;
  }

  return selectedMarket.supportedCurrencies.includes(currencyCode)
    ? currencyCode
    : null;
}

function resolveLocale(selectedMarket, localeCode) {
  if (!selectedMarket) return null;

  if (!localeCode) {
    return selectedMarket.defaultLocale;
  }

  return selectedMarket.supportedLocales.includes(localeCode) ? localeCode : null;
}

function normalizeHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function deriveCustomerName(email, providedName) {
  if (providedName?.trim()) {
    return providedName.trim();
  }

  if (!email) {
    return "Demo Customer";
  }

  const localPart = email.split("@")[0] || "demo.customer";
  const words = localPart
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);

  if (!words.length) {
    return "Demo Customer";
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function appendCheckoutLog(entry) {
  const serialized = [
    "============================================================",
    `Timestamp: ${entry.timestamp}`,
    `Context: ${entry.context}`,
    `Request: ${entry.request.method} ${entry.request.url}`,
    `Request headers: ${JSON.stringify(entry.request.headers, null, 2)}`,
    `Request body: ${entry.request.body || ""}`,
    `Response status: ${entry.response.status}`,
    `Response headers: ${JSON.stringify(entry.response.headers, null, 2)}`,
    `Response body: ${entry.response.body || ""}`,
    entry.error ? `Error: ${entry.error}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  await appendFile(checkoutLogPath, `${serialized}\n`, "utf8");
}

function parseCheckoutResponse(rawText) {
  try {
    return {
      rawText,
      data: rawText ? JSON.parse(rawText) : {},
    };
  } catch {
    return {
      rawText,
      data: rawText ? { raw: rawText } : {},
    };
  }
}

function performHttpRequest(requestUrl, options = {}) {
  const url = new URL(requestUrl);
  const transport = url.protocol === "https:" ? https : http;
  const requestHeaders = normalizeHeaders(options.headers);
  const requestBody = typeof options.body === "string" ? options.body : "";

  if (requestBody && !requestHeaders["Content-Length"] && !requestHeaders["content-length"]) {
    requestHeaders["Content-Length"] = Buffer.byteLength(requestBody, "utf8");
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method || "GET",
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            rawText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("error", reject);

    if (requestBody) {
      request.write(requestBody);
    }

    request.end();
  });
}

async function checkoutRequest(pathname, options = {}, context = "checkout_api") {
  const requestUrl = `${process.env.CHECKOUT_BASE_URL}${pathname}`;
  const requestHeaders = normalizeHeaders(options.headers);
  const requestBody = typeof options.body === "string" ? options.body : "";
  const method = options.method || "GET";

  try {
    const rawResponse = await performHttpRequest(requestUrl, options);
    const parsed = parseCheckoutResponse(rawResponse.rawText);
    const responseHeaders = normalizeHeaders(rawResponse.headers);
    const response = {
      ok: rawResponse.status >= 200 && rawResponse.status < 300,
      status: rawResponse.status,
      headers: responseHeaders,
    };

    await appendCheckoutLog({
      timestamp: new Date().toISOString(),
      context,
      request: {
        method,
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody,
      },
      response: {
        status: rawResponse.status,
        headers: responseHeaders,
        body: parsed.rawText,
      },
    });

    return { response, data: parsed.data };
  } catch (error) {
    await appendCheckoutLog({
      timestamp: new Date().toISOString(),
      context,
      request: {
        method,
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody,
      },
      response: {
        status: "NETWORK_ERROR",
        headers: {},
        body: "",
      },
      error: error.message,
    });

    throw error;
  }
}

app.post(
  "/webhooks/checkout",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const authHeader = req.get("Authorization");
      const signatureHeader = req.get("Cko-Signature");
      const rawBody = req.body;

      if (
        process.env.CHECKOUT_WEBHOOK_AUTH_VALUE &&
        authHeader !== process.env.CHECKOUT_WEBHOOK_AUTH_VALUE
      ) {
        return res.status(401).send("Invalid webhook authorization");
      }

      if (
        process.env.CHECKOUT_WEBHOOK_SIGNATURE_KEY &&
        !isValidSignature(
          rawBody,
          signatureHeader,
          process.env.CHECKOUT_WEBHOOK_SIGNATURE_KEY
        )
      ) {
        return res.status(401).send("Invalid webhook signature");
      }

      const event = JSON.parse(rawBody.toString("utf8"));
      const paymentId = event?.data?.id;
      const orderRef =
        event?.data?.reference || event?.data?.metadata?.merchant_order_id;

      if (paymentId && orderRef) {
        paymentToOrderRef.set(paymentId, orderRef);
      }

      if (orderRef) {
        const existingOrder = orders.get(orderRef) || { refunds: [] };
        const nextRefunds =
          event.type === "payment_refunded"
            ? [
                ...(existingOrder.refunds || []),
                {
                  eventType: event.type,
                  amount: event?.data?.amount,
                  processedOn: new Date().toISOString(),
                  eventData: event.data || null,
                },
              ]
            : existingOrder.refunds || [];

        mergeOrder(orderRef, {
          paymentId: paymentId || existingOrder.paymentId,
          paymentReference: event?.data?.reference || existingOrder.paymentReference,
          webhookReceivedAt: new Date().toISOString(),
          webhookEventType: event.type,
          webhookState: mapWebhookState(event.type),
          webhookConfirmed: ["payment_approved", "payment_captured", "card_verified"].includes(
            event.type
          ),
          lastWebhookData: event.data || null,
          refunds: nextRefunds,
        });
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);
      return res.status(400).send("Webhook processing failed");
    }
  }
);

app.use(express.json());
app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    publicKey: process.env.CHECKOUT_PUBLIC_KEY,
    environment: "sandbox",
    markets,
    locales,
    currencies,
    catalog: Object.values(catalog),
    checkoutLogPath: "logs/checkout-api.log",
  });
});

app.post("/api/payment-session", async (req, res) => {
  try {
    const {
      market = "NL",
      currency,
      locale,
      email,
      items = [],
      require3ds = false,
      checkoutMode = "flow",
    } = req.body;

    if (!email?.trim()) {
      return res.status(400).json({ error: "email_is_required" });
    }

    const selectedMarket = resolveMarket(market);
    if (!selectedMarket) {
      return res.status(400).json({ error: "invalid_market" });
    }

    const selectedCurrency = resolveCurrency(selectedMarket, currency);
    if (!selectedCurrency) {
      return res.status(400).json({ error: "invalid_currency_for_market" });
    }

    const selectedLocale = resolveLocale(selectedMarket, locale);
    if (!selectedLocale) {
      return res.status(400).json({ error: "invalid_locale_for_market" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "at_least_one_item_is_required" });
    }

    const normalizedItems = normalizeItems(items, selectedCurrency);

    if (normalizedItems.length === 0) {
      return res.status(400).json({ error: "no_valid_items" });
    }

    const amount = normalizedItems.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );

    const orderRef = buildOrderRef();
    const returnBase = `${process.env.APP_BASE_URL}/?order_ref=${encodeURIComponent(
      orderRef
    )}`;
    const customerName = deriveCustomerName(email);

    const payload = {
      amount,
      currency: selectedCurrency,
      processing_channel_id: process.env.CHECKOUT_PROCESSING_CHANNEL_ID,
      reference: orderRef,
      display_name: "iPhone Case",
      payment_type: "Regular",
      billing: {
        address: {
          country: selectedMarket.country,
        },
      },
      customer: {
        name: customerName,
        email: email.trim(),
      },
      items: normalizedItems,
      metadata: {
        merchant_order_id: orderRef,
        market: selectedMarket.code,
        locale: selectedLocale,
        require_3ds: Boolean(require3ds),
        checkout_mode: checkoutMode,
      },
      enabled_payment_methods: ["card", "applepay", "alipay_hk", "paypal"],
      success_url: `${returnBase}&status=succeeded`,
      failure_url: `${returnBase}&status=failed`,
      ...(require3ds
        ? {
            "3ds": {
              enabled: true,
              attempt_n3d: false,
            },
          }
        : {}),
    };

    const { response, data } = await checkoutRequest(
      "/payment-sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CHECKOUT_SECRET_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "create_payment_session"
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error: "checkout_payment_session_failed",
        details: data,
      });
    }

    mergeOrder(orderRef, {
      createdAt: new Date().toISOString(),
      market: selectedMarket.code,
      country: selectedMarket.country,
      currency: selectedCurrency,
      locale: selectedLocale,
      amount,
      email: email.trim(),
      customerName,
      require3ds: Boolean(require3ds),
      checkoutMode,
      items: normalizedItems,
      paymentSessionId: data.id,
      gatewayStatus: "payment_session_created",
      webhookConfirmed: false,
      refunds: [],
    });

    return res.json({
      ...data,
      orderRef,
      locale: selectedLocale,
      currency: selectedCurrency,
      require3ds: Boolean(require3ds),
      checkoutMode,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "internal_server_error",
      message: error.message,
    });
  }
});

app.get("/api/payments/:id", async (req, res) => {
  try {
    const paymentId = req.params.id;
    const hintedOrderRef = req.query.order_ref;

    const { response, data } = await checkoutRequest(
      `/payments/${paymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.CHECKOUT_SECRET_KEY}`,
          Accept: "application/json",
        },
      },
      "get_payment_details"
    );

    if (response.ok) {
      const orderRef =
        hintedOrderRef ||
        data.reference ||
        data?.metadata?.merchant_order_id ||
        paymentToOrderRef.get(paymentId);

      if (orderRef) {
        updateOrderFromPaymentDetails(orderRef, data);
      }
    }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "internal_server_error",
      message: error.message,
    });
  }
});

app.post("/api/payments/:id/refunds", async (req, res) => {
  try {
    const paymentId = req.params.id;
    const amount = Number(req.body.amount);
    const orderRef = req.body.orderRef;

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: "invalid_refund_amount" });
    }

    const { response: paymentResponse, data: payment } = await checkoutRequest(
      `/payments/${paymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.CHECKOUT_SECRET_KEY}`,
          Accept: "application/json",
        },
      },
      "get_payment_details_for_refund"
    );

    if (!paymentResponse.ok) {
      return res.status(paymentResponse.status).json(payment);
    }

    const refundableAmount = Number(payment?.balances?.available_to_refund ?? 0);

    if (!refundableAmount) {
      return res.status(400).json({ error: "payment_not_refundable_yet" });
    }

    if (amount > refundableAmount) {
      return res.status(400).json({
        error: "refund_amount_exceeds_available_to_refund",
        refundableAmount,
        currency: payment.currency,
      });
    }

    const refundReference = req.body.reference?.trim() || buildOrderRef("REFUND");
    const refundPayload = {
      amount,
      reference: refundReference,
      metadata: {
        merchant_order_id:
          orderRef || payment?.metadata?.merchant_order_id || payment.reference,
      },
    };

    const { response, data } = await checkoutRequest(
      `/payments/${paymentId}/refunds`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CHECKOUT_SECRET_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cko-Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(refundPayload),
      },
      "refund_payment"
    );

    if (response.ok) {
      const resolvedOrderRef =
        orderRef ||
        payment?.metadata?.merchant_order_id ||
        payment.reference ||
        paymentToOrderRef.get(paymentId);

      if (resolvedOrderRef) {
        const currentOrder = orders.get(resolvedOrderRef) || { refunds: [] };
        mergeOrder(resolvedOrderRef, {
          paymentId,
          refundRequestedAt: new Date().toISOString(),
          lastRefundRequest: {
            amount,
            currency: payment.currency,
            reference: refundReference,
            actionId: data.action_id,
          },
          refunds: [
            ...(currentOrder.refunds || []),
            {
              amount,
              currency: payment.currency,
              reference: refundReference,
              actionId: data.action_id,
              requestedAt: new Date().toISOString(),
              status: "refund_requested",
            },
          ],
        });
      }
    }

    return res.status(response.status).json({
      ...data,
      amount,
      currency: payment.currency,
      availableToRefundBeforeRequest: refundableAmount,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "internal_server_error",
      message: error.message,
    });
  }
});

app.get("/api/orders/:orderRef", (req, res) => {
  const order = orders.get(req.params.orderRef);

  if (!order) {
    return res.status(404).json({ error: "order_not_found" });
  }

  return res.json(order);
});

app.listen(port, () => {
  console.log(`Checkout Flow demo running at http://localhost:${port}`);
  console.log(`Checkout API log file: ${checkoutLogPath}`);
});
