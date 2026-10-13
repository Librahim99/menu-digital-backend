// Cuentas de la mesa: cuánto le toca a cada comensal y cuánto falta cobrar.
//
// Funciones puras (sin base): reciben los pedidos, los comensales, el reparto
// y los pagos, y devuelven la cuenta. Todo se calcula en centavos enteros y
// cada reparto usa el método del mayor resto, así las partes SIEMPRE suman
// exactamente el importe repartido (nunca sobra ni falta un centavo).

const SPLIT_MODES = ["none", "items", "equal", "custom"];

const toCents = (value) => Math.round(Number(value ?? 0) * 100);
const fromCents = (cents) => cents / 100;

/**
 * Reparte `totalCents` en proporción a `weights`. Los centavos que sobran del
 * redondeo van a las partes con mayor resto (a igual resto, a la primera).
 * @returns {number[]} centavos por parte; suman `totalCents`
 */
const allocate = (totalCents, weights) => {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0);
  const base = weights.map((weight) => Math.floor((totalCents * weight) / sum));
  let left = totalCents - base.reduce((acc, part) => acc + part, 0);
  const byRemainder = weights
    .map((weight, index) => ({ index, remainder: (totalCents * weight) % sum }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; left > 0; i = (i + 1) % byRemainder.length, left -= 1) base[byRemainder[i].index] += 1;
  return base;
};

// Importe de cada línea de un pedido. Sin descuento es precio × cantidad; con
// descuento, el total del pedido se reparte en proporción (suma el total).
const lineAmounts = (order) => {
  const gross = order.lines.map((line) => toCents(line.unitPrice) * line.quantity);
  const grossTotal = gross.reduce((acc, amount) => acc + amount, 0);
  const total = toCents(order.total);
  return grossTotal === total ? gross : allocate(total, gross);
};

/**
 * @param {object} input
 * @param {"none"|"items"|"equal"|"custom"} input.mode
 * @param {Array<{id, number, total, lines: Array<{id, title, option, quantity, unitPrice, authorName?, shared?}>}>} input.orders
 *        pedidos que se cobran (sin anulados ni devueltos), con sus líneas activas
 * @param {Array<{id, name, customAmount?}>} input.guests  comensales activos, en orden
 * @param {Array<{itemId, guestId, weight}>} input.shares
 * @param {Array<{guestId, amount}>} input.payments  solo los aprobados
 */
const computeBill = ({ mode = "none", orders = [], guests = [], shares = [], payments = [] }) => {
  const guestIndex = new Map(guests.map((guest, index) => [Number(guest.id), index]));
  const owed = guests.map(() => 0);
  const sharesByItem = new Map();
  for (const share of shares) {
    // Reparto que quedó apuntando a un comensal quitado: no cuenta.
    if (!guestIndex.has(Number(share.guestId))) continue;
    const key = Number(share.itemId);
    if (!sharesByItem.has(key)) sharesByItem.set(key, []);
    sharesByItem.get(key).push(share);
  }

  let total = 0;
  let unassignedItems = 0;
  const items = [];
  for (const order of orders) {
    const amounts = lineAmounts(order);
    order.lines.forEach((line, position) => {
      const amount = amounts[position];
      total += amount;
      const lineShares = (sharesByItem.get(Number(line.id)) ?? [])
        .slice()
        .sort((a, b) => guestIndex.get(Number(a.guestId)) - guestIndex.get(Number(b.guestId)));
      const parts = allocate(amount, lineShares.map((share) => share.weight));
      const assigned = lineShares.map((share, index) => ({
        guestId: Number(share.guestId), weight: share.weight, amount: fromCents(parts[index]),
      }));
      if (lineShares.length === 0) unassignedItems += amount;
      else if (mode === "items") lineShares.forEach((share, index) => { owed[guestIndex.get(Number(share.guestId))] += parts[index]; });
      items.push({
        id: Number(line.id),
        orderId: Number(order.id),
        orderNumber: order.number,
        title: line.title,
        option: line.option ?? null,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
        amount: fromCents(amount),
        authorName: line.authorName ?? null,
        shared: Boolean(line.shared),
        shares: assigned,
      });
    });
  }

  // Lo que nadie tiene asignado todavía, y lo asignado de más (solo importes a mano).
  let unassigned = 0;
  let overAssigned = 0;
  if (mode === "items") {
    unassigned = unassignedItems;
  } else if (mode === "equal") {
    if (guests.length === 0) unassigned = total;
    else allocate(total, guests.map(() => 1)).forEach((part, index) => { owed[index] = part; });
  } else if (mode === "custom") {
    guests.forEach((guest, index) => { owed[index] = toCents(guest.customAmount); });
    const assigned = owed.reduce((acc, amount) => acc + amount, 0);
    unassigned = Math.max(0, total - assigned);
    overAssigned = Math.max(0, assigned - total);
  }

  const paidBy = guests.map(() => 0);
  let paid = 0;
  let paidUnattributed = 0;
  for (const payment of payments) {
    const cents = toCents(payment.amount);
    paid += cents;
    const index = payment.guestId == null ? undefined : guestIndex.get(Number(payment.guestId));
    if (index === undefined) paidUnattributed += cents;
    else paidBy[index] += cents;
  }

  const pending = Math.max(0, total - paid);
  return {
    mode,
    total: fromCents(total),
    paid: fromCents(paid),
    pending: fromCents(pending),
    // Se cobró más que el total (ej. se quitó un producto después de pagar).
    overpaid: fromCents(Math.max(0, paid - total)),
    unassigned: fromCents(unassigned),
    overAssigned: fromCents(overAssigned),
    // Pagos que no se imputaron a ningún comensal.
    paidUnattributed: fromCents(paidUnattributed),
    status: paid === 0 ? "open" : pending === 0 ? "paid" : "partial",
    guests: guests.map((guest, index) => ({
      id: Number(guest.id),
      name: guest.name,
      fromGroup: guest.groupMemberId != null,
      customAmount: guest.customAmount == null ? null : Number(guest.customAmount),
      owed: fromCents(owed[index]),
      paid: fromCents(paidBy[index]),
      // Negativo: pagó de más (ej. pagó también lo de otro).
      balance: fromCents(owed[index] - paidBy[index]),
    })),
    items,
  };
};

module.exports = { SPLIT_MODES, toCents, fromCents, allocate, computeBill };
