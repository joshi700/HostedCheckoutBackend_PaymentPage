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
const BASKET = [
  { name: "Premium Watch", description: "Stainless steel, 42 mm", quantity: 1, unitPrice: 99.0 },
];

const cents = (n) => Math.round(n * 100);
const dollars = (c) => (c / 100).toFixed(2);

function buildCheckout({ orderId, returnUrl }) {
  const itemCents = BASKET.reduce((n, i) => n + cents(i.unitPrice) * i.quantity, 0);
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
      item: BASKET.map((i) => ({
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
    
    const postData = buildCheckout({
      orderId: orderid,
      returnUrl: process.env.RETURN_URL || "https://hosted-checkout-indol.vercel.app/ReceiptPage",
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

    res.send(sessionId);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
