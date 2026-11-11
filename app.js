let config;
let checkoutInstance;
let currentOrderRef = null;
let currentPaymentId = null;
let currentPaymentCurrency = null;
let availableToRefundMinor = 0;
let orderPoller = null;
let currentCheckoutMode = "flow";

const methodDefinitions = [
  { key: "card", title: "Card" },
  { key: "applepay", title: "Apple Pay" },
  { key: "paypal", title: "PayPal" },
  { key: "alipay_hk", title: "AlipayHK" },
];

const marketEl = document.getElementById("market");
const currencyEl = document.getElementById("currency");
const localeEl = document.getElementById("locale");
const emailEl = document.getElementById("email");
const require3dsEl = document.getElementById("require3ds");
const productsEl = document.getElementById("products");
const summaryEl = document.getElementById("summary");
const messageEl = document.getElementById("message");
const checkoutHintEl = document.getElementById("checkout-hint");
const paymentResultEl = document.getElementById("payment-result");
const orderResultEl = document.getElementById("order-result");
const refundResultEl = document.getElementById("refund-result");
const refundHintEl = document.getElementById("refund-hint");
const refundAmountEl = document.getElementById("refundAmount");
const refundButtonEl = document.getElementById("refundBtn");
const loadCheckoutBtn = document.getElementById("loadCheckoutBtn");
const loadMethodsBtn = document.getElementById("loadMethodsBtn");
const flowModeEl = document.getElementById("flow-mode");
const methodsModeEl = document.getElementById("methods-mode");

async function init() {
  const response = await fetch("/api/config");
  config = await response.json();

  syncSelectorsFromMarket();
  renderProducts();
  renderSummary();
  renderCheckoutHint();
  updateRefundUI();
  bindEvents();
  await handleReturnFromRedirect();
}

function bindEvents() {
  marketEl.addEventListener("change", () => {
    syncSelectorsFromMarket();
    renderProducts();
    renderSummary();
    clearCheckoutSurfaces();
    clearPaymentState();
  });

  currencyEl.addEventListener("change", () => {
    renderProducts();
    renderSummary();
    clearCheckoutSurfaces();
  });

  localeEl.addEventListener("change", () => {
    clearCheckoutSurfaces();
  });

  loadCheckoutBtn.addEventListener("click", () => createCheckout("flow"));
  loadMethodsBtn.addEventListener("click", () => createCheckout("methods"));
  refundButtonEl.addEventListener("click", submitRefund);
}

function syncSelectorsFromMarket() {
  const selectedMarket = config.markets[marketEl.value];
  if (!selectedMarket) return;

  currencyEl.innerHTML = "";
  localeEl.innerHTML = "";

  for (const currencyCode of selectedMarket.supportedCurrencies) {
    const option = document.createElement("option");
    option.value = currencyCode;
    option.textContent = `${currencyCode} — ${config.currencies[currencyCode].label}`;
    if (currencyCode === selectedMarket.defaultCurrency) {
      option.selected = true;
    }
    currencyEl.appendChild(option);
  }

  for (const localeCode of selectedMarket.supportedLocales) {
    const locale = config.locales.find((entry) => entry.code === localeCode);
    if (!locale) continue;

    const option = document.createElement("option");
    option.value = locale.code;
    option.textContent = locale.label;
    if (locale.code === selectedMarket.defaultLocale) {
      option.selected = true;
    }
    localeEl.appendChild(option);
  }
}

function renderProducts() {
  const currency = currencyEl.value;
  const previousCart = Object.fromEntries(
    getCart().map((item) => [item.id, item.quantity])
  );

  productsEl.innerHTML = "";

  for (const product of config.catalog) {
    const priceMinor = product.prices[currency];
    const wrapper = document.createElement("div");
    wrapper.className = "product";
    wrapper.innerHTML = `
      <div>
        <div class="product-name">${escapeHtml(product.name)}</div>
        <div class="product-price">${formatAmount(priceMinor, currency)}</div>
      </div>
      <div class="qty">
        <select data-product-id="${product.id}">
          <option value="0">0</option>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
      </div>
    `;

    productsEl.appendChild(wrapper);
  }

  productsEl.querySelectorAll("select").forEach((select, index) => {
    const productId = select.dataset.productId;
    select.value = String(previousCart[productId] ?? (index === 0 ? 1 : 0));
    select.addEventListener("change", () => {
      renderSummary();
      clearCheckoutSurfaces();
    });
  });
}

function renderSummary() {
  const currency = currencyEl.value;
  const cart = getCart();

  if (!cart.length) {
    summaryEl.innerHTML = "<p class='empty-state'>No items selected.</p>";
    return;
  }

  let total = 0;
  const lines = cart.map((item) => {
    const product = config.catalog.find((entry) => entry.id === item.id);
    const lineTotal = product.prices[currency] * item.quantity;
    total += lineTotal;

    return `
      <div class="summary-row">
        <span>${escapeHtml(product.name)} × ${item.quantity}</span>
        <span>${formatAmount(lineTotal, currency)}</span>
      </div>
    `;
  });

  lines.push(`
    <div class="summary-row summary-total">
      <span>Total</span>
      <span>${formatAmount(total, currency)}</span>
    </div>
  `);

  summaryEl.innerHTML = lines.join("");
}
function renderCheckoutHint() {
  checkoutHintEl.textContent = `Raw Checkout API request/response logs are appended to ${config.checkoutLogPath}.`;
}

function getCart() {
  return [...productsEl.querySelectorAll("select")]
    .map((select) => ({
      id: select.dataset.productId,
      quantity: Number(select.value),
    }))
    .filter((item) => item.quantity > 0);
}

function formatAmount(minor, currency) {
  return new Intl.NumberFormat(resolveIntlLocale(), {
    style: "currency",
    currency,
  }).format((minor || 0) / 100);
}

function resolveIntlLocale() {
  const locale = localeEl.value || "en";

  switch (locale) {
    case "zh-hk":
      return "zh-HK";
    case "nl":
      return "nl-NL";
    default:
      return "en-US";
  }
}

function renderMessage(text, type = "") {
  messageEl.className = type;
  messageEl.textContent = text;
}

function clearCheckoutSurfaces() {
  document.getElementById("flow-container").innerHTML = "";

  for (const method of methodDefinitions) {
    const container = document.getElementById(`${method.key}-container`);
    const badge = document.getElementById(`${method.key}-badge`);
    container.innerHTML = "";
    badge.textContent = "Waiting";
    badge.className = "availability-badge";
  }

  flowModeEl.classList.add("hidden");
  methodsModeEl.classList.add("hidden");
}

function setCheckoutView(mode) {
  currentCheckoutMode = mode;
  flowModeEl.classList.toggle("hidden", mode !== "flow");
  methodsModeEl.classList.toggle("hidden", mode !== "methods");
}

function renderEmptyState(target, text) {
  target.innerHTML = `<p class="empty-state">${escapeHtml(text)}</p>`;
}

function renderFieldList(target, fields, fallbackText) {
  if (!fields.length) {
    renderEmptyState(target, fallbackText);
    return;
  }

  target.innerHTML = fields
    .filter((field) => field.value !== undefined && field.value !== null && field.value !== "")
    .map(
      (field) => `
        <div class="result-row">
          <span class="result-label">${escapeHtml(field.label)}</span>
          <span class="result-value">${escapeHtml(String(field.value))}</span>
        </div>
      `
    )
    .join("");
}

function renderPaymentResult(data) {
  if (!data || typeof data === "string") {
    renderEmptyState(paymentResultEl, data || "No payment checked yet.");
    return;
  }

  renderFieldList(
    paymentResultEl,
    [
      { label: "Payment ID", value: data.id },
      { label: "Status", value: data.status || data.error },
      {
        label: "Approved",
        value: data.approved === undefined ? "" : data.approved ? "Yes" : "No",
      },
      {
        label: "Amount",
        value:
          data.amount && data.currency
            ? formatAmount(data.amount, data.currency)
            : "",
      },
      { label: "Response", value: data.response_summary },
      { label: "3DS", value: data["3ds"]?.enrolled ? `Enrolled ${data["3ds"].enrolled}` : "" },
    ],
    "No payment checked yet."
  );
}

function renderOrderResult(data) {
  if (!data || typeof data === "string") {
    renderEmptyState(orderResultEl, data || "No webhook state yet.");
    return;
  }

  renderFieldList(
    orderResultEl,
    [
      { label: "Order reference", value: data.orderRef },
      { label: "Checkout mode", value: data.checkoutMode },
      { label: "Market", value: data.market },
      { label: "Webhook state", value: data.webhookState || "Waiting" },
      { label: "Latest webhook", value: data.webhookEventType || "Not received yet" },
      {
        label: "Confirmed",
        value:
          data.webhookConfirmed === undefined
            ? ""
            : data.webhookConfirmed
              ? "Yes"
              : "No",
      },
      { label: "Gateway status", value: data.gatewayStatus },
    ],
    "No webhook state yet."
  );
}

function renderRefundResult(data) {
  if (!data || typeof data === "string") {
    renderEmptyState(refundResultEl, data || "No refund requested yet.");
    return;
  }

  renderFieldList(
    refundResultEl,
    [
      { label: "Action ID", value: data.action_id },
      { label: "Reference", value: data.reference },
      {
        label: "Refund amount",
        value:
          data.amount && data.currency
            ? formatAmount(data.amount, data.currency)
            : "",
      },
      { label: "Status", value: data.error || "Request accepted" },
    ],
    "No refund requested yet."
  );
}

function stopOrderPolling() {
  if (orderPoller) {
    clearInterval(orderPoller);
    orderPoller = null;
  }
}

function clearPaymentState() {
  stopOrderPolling();
  currentOrderRef = null;
  currentPaymentId = null;
  currentPaymentCurrency = null;
  availableToRefundMinor = 0;
  renderPaymentResult("No payment checked yet.");
  renderOrderResult("No webhook state yet.");
  renderRefundResult("No refund requested yet.");
  updateRefundUI();
}

function startOrderPolling(orderRef) {
  if (!orderRef) return;

  stopOrderPolling();

  orderPoller = setInterval(async () => {
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderRef)}`);

      if (response.status === 404) {
        stopOrderPolling();
        return;
      }

      if (!response.ok) return;

      const order = await response.json();
      renderOrderResult(order);

      if (order.paymentResult) {
        updateRefundUI(order.paymentResult);
      }

      const terminal =
        order.webhookConfirmed ||
        order.webhookState === "failed" ||
        order.webhookState === "refunded" ||
        order.gatewayStatus === "Captured" ||
        order.gatewayStatus === "Declined";

      if (terminal) {
        stopOrderPolling();
      }
    } catch (error) {
      console.error("Order poll failed:", error);
    }
  }, 3000);
}

function updateRefundUI(payment) {
  if (payment?.id) {
    currentPaymentId = payment.id;
    currentPaymentCurrency = payment.currency || currencyEl.value;
    availableToRefundMinor = Number(payment?.balances?.available_to_refund ?? 0);
  }

  const refundable = Boolean(currentPaymentId) && availableToRefundMinor > 0;
  refundAmountEl.disabled = !refundable;
  refundButtonEl.disabled = !refundable;

  if (refundable) {
    refundHintEl.textContent = `Refundable amount available: ${formatAmount(
      availableToRefundMinor,
      currentPaymentCurrency
    )}. Enter any full or partial refund amount in the same currency.`;
    refundAmountEl.placeholder = `e.g. ${(availableToRefundMinor / 100).toFixed(2)}`;
    return;
  }

  refundHintEl.textContent =
    "Refund becomes available after the payment is captured and has a positive available_to_refund balance.";
  refundAmountEl.placeholder = "Refund amount";
}

async function verifyPayment(paymentId, orderRef) {
  const response = await fetch(
    `/api/payments/${encodeURIComponent(paymentId)}?order_ref=${encodeURIComponent(
      orderRef || ""
    )}`
  );

  const data = await response.json();
  renderPaymentResult(data);

  if (response.ok) {
    updateRefundUI(data);
  }

  if (response.ok && orderRef) {
    startOrderPolling(orderRef);
  }

  return data;
}

async function createCheckout(mode) {
  try {
    renderMessage("");
    renderPaymentResult("No payment checked yet.");
    renderOrderResult("No webhook state yet.");
    renderRefundResult("No refund requested yet.");
    stopOrderPolling();
    currentPaymentId = null;
    currentPaymentCurrency = null;
    availableToRefundMinor = 0;
    clearCheckoutSurfaces();
    updateRefundUI();

    const email = emailEl.value.trim();
    if (!email) {
      renderMessage("Please enter an email address.", "error");
      return;
    }

    const items = getCart();
    if (!items.length) {
      renderMessage("Please select at least one product.", "error");
      return;
    }

    setLoadingState(true, mode);

    const response = await fetch("/api/payment-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        market: marketEl.value,
        currency: currencyEl.value,
        locale: localeEl.value,
        email,
        items,
        require3ds: require3dsEl.checked,
        checkoutMode: mode,
      }),
    });

    const paymentSession = await response.json();

    if (!response.ok) {
      renderMessage("Failed to create payment session.", "error");
      renderPaymentResult(paymentSession);
      return;
    }

    currentOrderRef = paymentSession.orderRef;
    currentCheckoutMode = mode;
    startOrderPolling(currentOrderRef);

    checkoutInstance = await CheckoutWebComponents({
      paymentSession,
      publicKey: config.publicKey,
      environment: config.environment,
      locale: localeEl.value || paymentSession.locale || "en",
      onPaymentCompleted: async (_component, paymentResponse) => {
        renderMessage(
          "Payment completed in browser. Verifying with backend.",
          "success"
        );
        await verifyPayment(paymentResponse.id, currentOrderRef);
      },
      onError: (_component, error) => {
        console.error(error);
        renderMessage("Checkout returned an error. Check the saved API logs.", "error");
      },
    });

    if (mode === "flow") {
      await mountFlowCheckout();
    } else {
      await mountIndividualMethods();
    }

    renderMessage(
      mode === "flow"
        ? "Smart checkout loaded."
        : "Individual payment methods processed for this session.",
      "success"
    );
  } catch (error) {
    console.error(error);
    renderMessage("Unexpected error.", "error");
    renderPaymentResult({ error: error.message });
  } finally {
    setLoadingState(false);
  }
}

async function mountFlowCheckout() {
  setCheckoutView("flow");
  const flow = checkoutInstance.create("flow");
  flow.mount("#flow-container");
}

async function mountIndividualMethods() {
  setCheckoutView("methods");

  for (const method of methodDefinitions) {
    const containerId = `${method.key}-container`;
    const badgeId = `${method.key}-badge`;
    const container = document.getElementById(containerId);
    const badge = document.getElementById(badgeId);

    try {
      const component = checkoutInstance.create(method.key);
      const isAvailable = component.isAvailable
        ? await component.isAvailable()
        : true;

      if (!isAvailable) {
        container.innerHTML =
          "<p class='method-unavailable'>Not available for this session.</p>";
        badge.textContent = "Unavailable";
        badge.className = "availability-badge is-unavailable";
        continue;
      }

      component.mount(`#${containerId}`);
      badge.textContent = "Mounted";
      badge.className = "availability-badge is-mounted";
    } catch (error) {
      console.error(`${method.key} mount failed`, error);
      container.innerHTML =
        "<p class='method-unavailable'>Could not mount this payment method.</p>";
      badge.textContent = "Error";
      badge.className = "availability-badge is-error";
    }
  }
}

function setLoadingState(isLoading, mode = currentCheckoutMode) {
  loadCheckoutBtn.disabled = isLoading;
  loadMethodsBtn.disabled = isLoading;

  if (!isLoading) {
    loadCheckoutBtn.textContent = "Open smart checkout";
    loadMethodsBtn.textContent = "Show payment methods separately";
    return;
  }

  loadCheckoutBtn.textContent =
    mode === "flow" ? "Opening smart checkout..." : "Open smart checkout";
  loadMethodsBtn.textContent =
    mode === "methods"
      ? "Loading payment methods..."
      : "Show payment methods separately";
}

function parseAmountToMinor(value) {
  const normalized = String(value || "").trim();

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

async function submitRefund() {
  try {
    renderMessage("");

    if (!currentPaymentId) {
      renderMessage("No refundable payment found yet.", "error");
      return;
    }

    const refundMinor = parseAmountToMinor(refundAmountEl.value);
    if (!refundMinor || refundMinor <= 0) {
      renderMessage("Enter a valid refund amount.", "error");
      return;
    }

    if (refundMinor > availableToRefundMinor) {
      renderMessage("Refund amount exceeds the available refundable amount.", "error");
      return;
    }

    refundButtonEl.disabled = true;
    refundButtonEl.textContent = "Submitting refund...";

    const response = await fetch(
      `/api/payments/${encodeURIComponent(currentPaymentId)}/refunds`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: refundMinor,
          orderRef: currentOrderRef,
        }),
      }
    );

    const data = await response.json();
    renderRefundResult(data);

    if (!response.ok) {
      renderMessage("Refund request failed.", "error");
      return;
    }

    renderMessage(
      "Refund request accepted. Check webhook/order confirmation for the final outcome.",
      "success"
    );

    if (currentPaymentId) {
      await verifyPayment(currentPaymentId, currentOrderRef);
    }
  } catch (error) {
    console.error(error);
    renderRefundResult({ error: error.message });
    renderMessage("Unexpected refund error.", "error");
  } finally {
    refundButtonEl.disabled = availableToRefundMinor <= 0;
    refundButtonEl.textContent = "Submit refund";
  }
}

async function handleReturnFromRedirect() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const paymentId = params.get("cko-payment-id");
  const orderRef = params.get("order_ref");

  if (!status && !paymentId && !orderRef) {
    return;
  }

  if (orderRef) {
    currentOrderRef = orderRef;
    startOrderPolling(orderRef);
  }

  if (status === "succeeded") {
    renderMessage("Customer returned from redirect flow.", "success");
  } else if (status === "failed") {
    renderMessage("Customer returned from failed or cancelled redirect flow.", "error");
  }

  if (paymentId) {
    await verifyPayment(paymentId, orderRef);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

init();
