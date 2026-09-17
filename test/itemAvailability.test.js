const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getEmptySchedule,
  isScheduleAvailableAt,
  validateAvailabilitySchedule,
} = require("../src/utils/itemAvailability");

test("acepta varios rangos separados el mismo día", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [
    { from: "12:00", to: "15:00" },
    { from: "20:00", to: "23:30" },
  ];

  assert.equal(validateAvailabilitySchedule(schedule).error, undefined);
});

test("calcula horarios nocturnos en el huso de Buenos Aires", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [{ from: "20:00", to: "02:00" }];

  // Martes 01:00 y 03:00 en Buenos Aires, respectivamente.
  assert.equal(isScheduleAvailableAt(schedule, new Date("2026-08-25T04:00:00Z")), true);
  assert.equal(isScheduleAvailableAt(schedule, new Date("2026-08-25T06:00:00Z")), false);
});

test("detecta solapamientos entre un rango nocturno y el día siguiente", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.sun = [{ from: "23:00", to: "02:00" }];
  schedule.mon = [{ from: "01:00", to: "03:00" }];

  assert.match(validateAvailabilitySchedule(schedule).error, /superponerse/);
});

test("un horario activo requiere al menos un rango", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;

  assert.match(validateAvailabilitySchedule(schedule).error, /al menos un horario/);
});

test("el rango de fechas acota la programación y afuera no rige", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [{ from: "12:00", to: "15:00" }];
  schedule.dateRange = { from: "2026-08-17", to: "2026-08-23" };

  const { schedule: normalized, error } = validateAvailabilitySchedule(schedule);
  assert.equal(error, undefined);
  assert.equal(normalized.dateRange.from.toISOString(), "2026-08-17T03:00:00.000Z");

  // Lunes 17 dentro del rango: manda el horario semanal.
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-17T13:00:00-03:00")), true);
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-17T16:00:00-03:00")), false);
  // Lunes siguiente, ya fuera del rango: la programación deja de restringir.
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-24T16:00:00-03:00")), true);
});

test("horas iguales cubren las 24 horas desde esa hora", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [{ from: "10:00", to: "10:00" }];

  const { schedule: normalized, error } = validateAvailabilitySchedule(schedule);
  assert.equal(error, undefined);

  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-17T09:30:00-03:00")), false);
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-17T23:00:00-03:00")), true);
  // Sigue cubierto el martes hasta las 10:00.
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-18T09:00:00-03:00")), true);
  assert.equal(isScheduleAvailableAt(normalized, new Date("2026-08-18T10:30:00-03:00")), false);
});

test("rechaza un rango de fechas invertido", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [{ from: "12:00", to: "15:00" }];
  schedule.dateRange = { from: "2026-08-23", to: "2026-08-17" };

  assert.match(validateAvailabilitySchedule(schedule).error, /posterior/);
});
