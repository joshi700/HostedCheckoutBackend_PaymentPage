const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require("crypto");
const http = require('http');
const https = require('https');
require('dotenv').config(); // Load environment variables

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3005;

// ---------------------------------------------------------------------------
// What the hosted Payment Page displays. Every field below renders somewhere on
// Mastercard's page: the order summary, the customer and billing boxes, and the
// merchant footer. Plain ASCII only — the page mis-renders some non-ASCII (it
// shows U+00B7 as "A-circumflex, middle dot").
// ---------------------------------------------------------------------------

const MERCHANT = {
  name: "GJ Enterprises LLC",
  url: "https://www.example.com",
  email: "support@example.com",
  phone: "+1 555 010 0199",
  address: {
    line1: "100 Example Street",
    line2: "Suite 400",
    line3: "St Louis, MO 63102",
    line4: "United States",
  },
};

const CUSTOMER = {
  firstName: "Sample",
  lastName: "Payer",
  email: "sample.payer@example.com",
  mobilePhone: "+1 5557891238",
};

const ADDRESS = {
  street: "11 N 4th St",
  street2: "Apt 2B",
  city: "St Louis",
  stateProvince: "MO",
  postcodeZip: "63102",
  country: "USA",
};

// The basket is the single source of truth for the amount. The gateway rejects
// a session unless itemAmount + tax - discount equals the total exactly.
// DEFAULT_BASKET is used when a request carries no cart (the original frontend).
const DEFAULT_BASKET = [
  { name: "Premium Watch", description: "Stainless steel, 42 mm", quantity: 1, unitPrice: 99.0 },
];

// TechGear storefront catalogue. Prices live here, not in the browser: the
// frontend sends only product ids and quantities, so a shopper can't change
// what they're charged. Keep in step with PRODUCTS in the frontend's
// src/techgear/Storefront.jsx.
const CATALOG = {
  "mechkey-pro-60": { name: "MechKey Pro 60%", description: "60% mechanical keyboard", unitPrice: 249.0 },
  "velocity-wireless": { name: "Velocity Wireless", description: "Wireless gaming mouse", unitPrice: 149.0 },
  "sonic-blast-headset": { name: "Sonic Blast Headset", description: "Wireless gaming headset", unitPrice: 199.0 },
  "spectre-x15": { name: "Spectre X15 Laptop", description: "15.6 in creator laptop", unitPrice: 1299.0 },
};

// Turn [{ id, qty }] from the request into basket lines. Unknown ids and bad
// quantities are dropped; an empty result falls back to DEFAULT_BASKET.
function basketFrom(items) {
  if (!Array.isArray(items)) return DEFAULT_BASKET;
  const lines = items
    .filter((i) => i && CATALOG[i.id] && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= 9)
    .map((i) => ({ ...CATALOG[i.id], quantity: i.qty }));
  return lines.length ? lines : DEFAULT_BASKET;
}

// The shopper is sent to returnUrl after paying (or cancelUrl from Back). Only origins we deploy the
// frontend to are accepted, so the backend can't be used to redirect elsewhere.
const ALLOWED_RETURN_ORIGINS = (process.env.ALLOWED_RETURN_ORIGINS ||
  "https://hosted-checkout-indol.vercel.app,http://localhost:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);
const PREVIEW_ORIGIN = /^https:\/\/hosted-checkout-[a-z0-9-]+\.vercel\.app$/;

function allowedUrl(requested, fallback) {
  try {
    const url = new URL(requested);
    if (ALLOWED_RETURN_ORIGINS.includes(url.origin) || PREVIEW_ORIGIN.test(url.origin)) return url.toString();
  } catch { /* not a URL */ }
  return fallback;
}

const returnUrlFrom = (requested) =>
  allowedUrl(requested, process.env.RETURN_URL || "https://hosted-checkout-indol.vercel.app/ReceiptPage");

// Where the Payment Page's Back/cancel link sends the shopper. Same allow-list
// as returnUrl; without one the gateway falls back to the merchant's own URL.
const cancelUrlFrom = (requested) =>
  allowedUrl(requested, process.env.CANCEL_URL || "https://hosted-checkout-indol.vercel.app/?cancelled=1");

const cents = (n) => Math.round(n * 100);
const dollars = (c) => (c / 100).toFixed(2);

function buildCheckout({ orderId, returnUrl, cancelUrl, basket }) {
  const itemCents = basket.reduce((n, i) => n + cents(i.unitPrice) * i.quantity, 0);
  const taxCents = 0;

  return {
    apiOperation: "INITIATE_CHECKOUT",
    checkoutMode: "WEBSITE",
    interaction: {
      operation: "PURCHASE",
      merchant: MERCHANT,
      // READ_ONLY shows the prefilled boxes without letting the payer edit them.
      displayControl: {
        billingAddress: "READ_ONLY",
        customerEmail: "READ_ONLY",
        shipping: "READ_ONLY",
      },
      locale: "en_US",
      returnUrl,
      cancelUrl,
    },
    order: {
      id: orderId,
      // The page has no field that displays order.id; the description is shown
      // verbatim, so it carries the id onto the page.
      description: `Order ${orderId} - ${process.env.ORDER_DESCRIPTION || "Goods and Services"}`,
      currency: process.env.CURRENCY || "USD",
      amount: dollars(itemCents + taxCents),
      itemAmount: dollars(itemCents),
      taxAmount: dollars(taxCents),
      item: basket.map((i) => ({
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        unitPrice: dollars(cents(i.unitPrice)),
      })),
    },
    customer: CUSTOMER,
    billing: { address: ADDRESS },
    shipping: {
      contact: { firstName: CUSTOMER.firstName, lastName: CUSTOMER.lastName },
      address: ADDRESS,
    },
  };
}

app.post('/', async (req, res) => {
  try {
    const trxid = crypto.randomBytes(16).toString("hex");
    const orderid = crypto.randomBytes(16).toString("hex");
    
    const body = req.body || {};
    const postData = buildCheckout({
      orderId: orderid,
      returnUrl: returnUrlFrom(body.returnUrl),
      cancelUrl: cancelUrlFrom(body.cancelUrl),
      basket: basketFrom(body.items),
    });

    const axiosConfig = {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        "Access-Control-Allow-Origin": "*",
        'Authorization': `Basic ${process.env.MASTERCARD_AUTH_TOKEN}`,
        "Accept": "application/json"
      }
    };

    const apiUrl = `${process.env.MASTERCARD_API_BASE_URL}/api/rest/version/${process.env.API_VERSION}/merchant/${process.env.MERCHANT_ID}/session`;
    const response = await axios.post(apiUrl, postData, axiosConfig);
    
    console.log("RESPONSE RECEIVED Create: ", response.data.session.id);
    const sessionId = response.data.session.id;

    // The TechGear frontend asks for JSON so its receipt can verify the result:
    // the gateway's resultIndicator on return must equal this successIndicator.
    // Older clients still get the bare session id as text.
    if (body.responseFormat === "json") {
      return res.json({
        sessionId,
        successIndicator: response.data.successIndicator,
        orderId: orderid,
        amount: postData.order.amount,
        currency: postData.order.currency,
        items: postData.order.item,
      });
    }
    res.send(sessionId);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
