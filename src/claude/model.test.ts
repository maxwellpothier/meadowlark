import { describe, expect, it } from "vitest";
import { rect } from "../test/fixtures";
import { arrowEndpoints, prepareEdit, projectEdits, toShapes, type Shape } from "./model";

let n = 0;
const newId = () => `new${++n}`;

describe("toShapes", () => {
  it("folds bound text into its container and reports arrow ends", () => {
    const shapes = toShapes([
      rect({ id: "box", x: 10.4, y: 20.6, width: 100, height: 50, boundElements: [{ type: "text", id: "t" }], strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff" }),
      rect({ id: "t", type: "text", containerId: "box", text: "API\nserver", originalText: "API server" }),
      rect({ id: "free", type: "text", text: "note", x: 0, y: 0, width: 40, height: 20 }),
      rect({ id: "arr", type: "arrow", x: 0, y: 0, width: 5, height: 0, startBinding: { elementId: "box" }, endBinding: null }),
      rect({ id: "gone", isDeleted: true }),
    ]);
    expect(shapes).toEqual([
      { id: "box", type: "rectangle", x: 10, y: 21, width: 100, height: 50, label: "API server", backgroundColor: "#a5d8ff" },
      expect.objectContaining({ id: "free", type: "text", label: "note" }),
      expect.objectContaining({ id: "arr", type: "arrow", start: "box" }),
    ]);
    expect(shapes[2]).not.toHaveProperty("end");
  });
});

describe("prepareEdit", () => {
  const page: Shape[] = [
    { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
    { id: "b", type: "rectangle", x: 200, y: 0, width: 100, height: 50 },
    { id: "l", type: "line", x: 0, y: 100, width: 50, height: 0 },
  ];

  it("assigns ids to new shapes and accepts arrows between new and existing shapes", () => {
    const result = prepareEdit(page, { add: [{ id: "c", type: "ellipse", x: 0, y: 200 }, { type: "arrow", start: "a", end: "c" }] }, newId);
    expect(result.errors).toEqual([]);
    expect(result.edit?.add?.map((s) => s.id)).toEqual(["c", expect.stringMatching(/^new/)]);
  });

  it("reports every problem at once", () => {
    const result = prepareEdit(
      page,
      {
        remove: ["missing"],
        update: [{ id: "a", start: "b" }],
        add: [
          { id: "a", type: "rectangle", x: 0, y: 0 },
          { id: "bad id!", type: "text", x: 0, y: 0 },
          { type: "arrow", start: "l" },
          { type: "rectangle", x: 0, y: 0, children: ["a"] },
        ],
      },
      newId,
    );
    expect(result.errors).toEqual([
      'remove: no element "missing" on this page.',
      'add: id "a" is already in use.',
      'add: id "bad id!" must be 1-64 letters, digits, "-" or "_".',
      'update: "a" is a rectangle; only arrows have start/end.',
      expect.stringContaining("text elements need a label"),
      expect.stringContaining("x and y are required unless the arrow has both start and end"),
      expect.stringContaining('arrows can\'t attach to a line ("l")'),
      expect.stringContaining("only frames have children"),
    ]);
  });

  it("allows removing at most half of the page", () => {
    expect(prepareEdit(page, { remove: ["a"] }, newId).errors).toEqual([]);
    expect(prepareEdit(page, { remove: ["a", "b"] }, newId).errors[0]).toContain("removes 2 of 3 elements");
  });
});

describe("projectEdits", () => {
  it("applies removes, updates and adds, and routes attached arrows", () => {
    const page: Shape[] = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 100 },
      { id: "x", type: "arrow", x: 0, y: 0, width: 1, height: 1, start: "a", end: "b" },
    ];
    const out = projectEdits(page, [
      { remove: ["b"], update: [{ id: "a", label: "Moved", x: 10 }] },
      { add: [{ id: "c", type: "rectangle", x: 10, y: 300, width: 100, height: 100 }, { id: "y", type: "arrow", start: "a", end: "c" }] },
    ]);
    expect(out.map((s) => s.id)).toEqual(["a", "x", "c", "y"]);
    expect(out[0]).toMatchObject({ x: 10, label: "Moved" });
    expect(out[1]).not.toHaveProperty("end"); // its end was removed
    // a's bottom edge (y=100) plus the gap, down to c's top edge (y=300) minus the gap.
    expect(out[3]).toMatchObject({ x: 60, y: 108, width: 0, height: 184 });
  });
});

describe("arrowEndpoints", () => {
  it("leaves boxes through the side facing the other box", () => {
    const [p, q] = arrowEndpoints(
      { type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { type: "ellipse", x: 300, y: 0, width: 100, height: 50 },
    );
    expect(p).toEqual([108, 25]);
    expect(q).toEqual([292, 25]);
  });
});
