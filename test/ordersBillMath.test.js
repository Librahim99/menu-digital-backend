const test = require("node:test");
const assert = require("node:assert/strict");
const { allocate, computeBill, toCents } = require("../src/orders/services/billMath");

// Cuenta de la mesa: los cálculos puros. Todo en centavos; cada reparto tiene
// que sumar exactamente lo repartido.

const sum = (values) => values.reduce((acc, value) => acc + value, 0);
const cents = (values) => values.map(toCents);

const order = (id, lines, over = {}) => ({
  id, number: id,
  total: over.total ?? sum(lines.map((line) => line.unitPrice * line.quantity)),
  lines: lines.map((line, index) => ({ id: id * 100 + index, title: `P${index}`, option: null, ...line })),
});
const guests = (...names) => names.map((name, index) => ({ id: index + 1, name }));

test("allocate: reparte por partes y la suma siempre da el total", () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(1000, [2, 1]), [667, 333]);
  assert.deepEqual(allocate(100, [1]), [100]);
  assert.deepEqual(allocate(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.deepEqual(allocate(500, []), []);
  assert.deepEqual(allocate(500, [0, 0]), [0, 0]);
});

test("allocate: nunca pierde ni inventa un centavo, con cualquier combinación", () => {
  for (let total = 0; total <= 2500; total += 37) {
    for (const weights of [[1, 1], [1, 1, 1], [3, 2, 1], [7, 1, 1, 1], [1, 100], [5, 5, 5, 5, 5, 5, 5]]) {
      const parts = allocate(total, weights);
      assert.equal(sum(parts), total, `${total} entre ${weights}`);
      assert.ok(parts.every((part) => Number.isInteger(part) && part >= 0));
    }
  }
});

test("sin dividir: total, pagado y pendiente de la mesa", () => {
  const bill = computeBill({
    orders: [order(1, [{ unitPrice: 4500, quantity: 2 }, { unitPrice: 1200.5, quantity: 1 }]), order(2, [{ unitPrice: 800, quantity: 3 }])],
    payments: [{ guestId: null, amount: "5000.00" }],
  });
  assert.equal(bill.total, 12600.5);
  assert.equal(bill.paid, 5000);
  assert.equal(bill.pending, 7600.5);
  assert.equal(bill.status, "partial");
  assert.equal(bill.paidUnattributed, 5000);
  assert.equal(bill.items.length, 3);
  assert.equal(bill.items[0].amount, 9000);
});

test("por productos: entero a uno, fraccionado entre varios y con partes desiguales", () => {
  const orders = [order(1, [
    { unitPrice: 10000, quantity: 1 },   // pizza, entre los tres
    { unitPrice: 2500, quantity: 2 },    // dos cervezas: Ana 2 partes, Beto 1
    { unitPrice: 3000, quantity: 1 },    // postre, solo de Caro
    { unitPrice: 1000, quantity: 1 },    // sin asignar
  ])];
  const bill = computeBill({
    mode: "items",
    orders,
    guests: guests("Ana", "Beto", "Caro"),
    shares: [
      { itemId: 100, guestId: 1, weight: 1 }, { itemId: 100, guestId: 2, weight: 1 }, { itemId: 100, guestId: 3, weight: 1 },
      { itemId: 101, guestId: 1, weight: 2 }, { itemId: 101, guestId: 2, weight: 1 },
      { itemId: 102, guestId: 3, weight: 1 },
    ],
  });
  const owed = Object.fromEntries(bill.guests.map((guest) => [guest.name, guest.owed]));
  assert.deepEqual(owed, { Ana: 3333.34 + 3333.33, Beto: 3333.33 + 1666.67, Caro: 3333.33 + 3000 });
  assert.equal(bill.unassigned, 1000);
  assert.equal(sum(cents(bill.guests.map((guest) => guest.owed))) + toCents(bill.unassigned), toCents(bill.total));
  assert.deepEqual(bill.items[1].shares, [
    { guestId: 1, weight: 2, amount: 3333.33 }, { guestId: 2, weight: 1, amount: 1666.67 },
  ]);
});

test("partes iguales: los centavos que sobran van a los primeros y todo suma", () => {
  const bill = computeBill({
    mode: "equal", orders: [order(1, [{ unitPrice: 10000, quantity: 1 }])], guests: guests("A", "B", "C"),
  });
  assert.deepEqual(bill.guests.map((guest) => guest.owed), [3333.34, 3333.33, 3333.33]);
  assert.equal(bill.unassigned, 0);

  const nobody = computeBill({ mode: "equal", orders: [order(1, [{ unitPrice: 500, quantity: 1 }])] });
  assert.equal(nobody.unassigned, 500, "sin comensales no hay entre quién dividir");
});

test("importes personalizados: lo que falta asignar y lo asignado de más", () => {
  const orders = [order(1, [{ unitPrice: 9000, quantity: 1 }])];
  const short = computeBill({
    mode: "custom", orders,
    guests: [{ id: 1, name: "A", customAmount: "5000.00" }, { id: 2, name: "B", customAmount: "1500.50" }, { id: 3, name: "C" }],
  });
  assert.deepEqual(short.guests.map((guest) => guest.owed), [5000, 1500.5, 0]);
  assert.equal(short.unassigned, 2499.5);
  assert.equal(short.overAssigned, 0);

  const over = computeBill({ mode: "custom", orders, guests: [{ id: 1, name: "A", customAmount: 9500 }] });
  assert.equal(over.unassigned, 0);
  assert.equal(over.overAssigned, 500);
});

test("pagos parciales: cuánto debe cada uno y cuánto queda", () => {
  const bill = computeBill({
    mode: "equal",
    orders: [order(1, [{ unitPrice: 12000, quantity: 1 }])],
    guests: guests("Ana", "Beto", "Caro"),
    payments: [
      { guestId: 1, amount: 4000 },            // Ana pagó lo suyo
      { guestId: 2, amount: 1500 }, { guestId: 2, amount: 500 }, // Beto, en dos veces
      { guestId: 3, amount: 5000 },            // Caro pagó de más (invita)
    ],
  });
  assert.deepEqual(bill.guests.map((guest) => [guest.paid, guest.balance]), [[4000, 0], [2000, 2000], [5000, -1000]]);
  assert.equal(bill.paid, 11000);
  assert.equal(bill.pending, 1000);
  assert.equal(bill.status, "partial");
});

test("cuenta saldada y cobro de más (se quitó un producto después de pagar)", () => {
  const orders = [order(1, [{ unitPrice: 3000, quantity: 1 }])];
  const paid = computeBill({ orders, payments: [{ guestId: null, amount: 3000 }] });
  assert.equal(paid.status, "paid");
  assert.equal(paid.pending, 0);
  assert.equal(paid.overpaid, 0);

  const over = computeBill({ orders, payments: [{ guestId: null, amount: 3500 }] });
  assert.equal(over.pending, 0);
  assert.equal(over.overpaid, 500);

  assert.equal(computeBill({ orders }).status, "open");
});

test("un pedido con descuento reparte su total entre las líneas sin perder centavos", () => {
  const discounted = order(1, [{ unitPrice: 3333, quantity: 1 }, { unitPrice: 3333, quantity: 1 }, { unitPrice: 3334, quantity: 1 }], { total: 9000 });
  const bill = computeBill({ mode: "items", orders: [discounted], guests: guests("A"), shares: [{ itemId: 100, guestId: 1, weight: 1 }] });
  assert.equal(bill.total, 9000);
  assert.equal(sum(cents(bill.items.map((item) => item.amount))), 900000);
  assert.equal(bill.guests[0].owed, bill.items[0].amount);
});

test("el reparto que apunta a un comensal quitado no cuenta; el pago a su nombre queda sin imputar", () => {
  const bill = computeBill({
    mode: "items",
    orders: [order(1, [{ unitPrice: 2000, quantity: 1 }])],
    guests: guests("Ana"),
    shares: [{ itemId: 100, guestId: 99, weight: 1 }],
    payments: [{ guestId: 99, amount: 500 }],
  });
  assert.equal(bill.unassigned, 2000);
  assert.equal(bill.paidUnattributed, 500);
  assert.equal(bill.pending, 1500);
});

test("mesa sin consumos: todo en cero, sin errores", () => {
  const bill = computeBill({ mode: "equal", guests: guests("A", "B") });
  assert.equal(bill.total, 0);
  assert.equal(bill.pending, 0);
  assert.deepEqual(bill.guests.map((guest) => guest.owed), [0, 0]);
  assert.equal(bill.status, "open");
});

test("propiedad: en cualquier modo, lo de los comensales + lo sin asignar = total", () => {
  const orders = [
    order(1, [{ unitPrice: 1999.99, quantity: 3 }, { unitPrice: 0.01, quantity: 7 }, { unitPrice: 450.5, quantity: 1 }]),
    order(2, [{ unitPrice: 777.77, quantity: 2 }]),
  ];
  const people = guests("A", "B", "C", "D", "E", "F", "G");
  const shares = [
    ...people.map((guest) => ({ itemId: 100, guestId: guest.id, weight: guest.id })),
    { itemId: 101, guestId: 2, weight: 1 }, { itemId: 101, guestId: 5, weight: 3 },
    { itemId: 200, guestId: 7, weight: 1 },
  ];
  for (const mode of ["items", "equal"]) {
    const bill = computeBill({ mode, orders, guests: people, shares });
    assert.equal(sum(cents(bill.guests.map((guest) => guest.owed))) + toCents(bill.unassigned), toCents(bill.total), mode);
  }
});
