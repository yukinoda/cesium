import {
  Cartesian3,
  Cartographic,
  defined,
  Ellipsoid,
  EventHelper,
  GeographicProjection,
  GeographicTilingScheme,
  Intersect,
  Math as CesiumMath,
  Rectangle,
  Visibility,
  Camera,
  GlobeSurfaceTileProvider,
  GlobeTranslucencyState,
  ImageryLayerCollection,
  QuadtreePrimitive,
  QuadtreeTileLoadState,
  SceneMode,
} from "../../index.js";
import MockTerrainProvider from "../../../../Specs/MockTerrainProvider.js";
import TerrainTileProcessor from "../../../../Specs/TerrainTileProcessor.js";

import createScene from "../../../../Specs/createScene.js";
import pollToPromise from "../../../../Specs/pollToPromise.js";

function expectCartographicToEqualEpsilon(actual, expected, epsilon) {
  expect(
    CesiumMath.equalsEpsilon(actual.longitude, expected.longitude, epsilon),
  ).toBe(true);
  expect(
    CesiumMath.equalsEpsilon(actual.latitude, expected.latitude, epsilon),
  ).toBe(true);
  expect(
    CesiumMath.equalsEpsilon(actual.height, expected.height, epsilon),
  ).toBe(true);
}

describe("Scene/QuadtreePrimitive", function () {
  describe("selectTilesForRendering", function () {
    let scene;
    let camera;
    let frameState;
    let quadtree;
    let mockTerrain;
    let tileProvider;
    let imageryLayerCollection;
    let surfaceShaderSet;
    let processor;
    let rootTiles;

    beforeEach(function () {
      scene = {
        mapProjection: new GeographicProjection(),
        drawingBufferWidth: 1000,
        drawingBufferHeight: 1000,
      };

      camera = new Camera(scene);

      frameState = {
        frameNumber: 0,
        passes: {
          render: true,
        },
        camera: camera,
        fog: {
          enabled: false,
        },
        context: {
          drawingBufferWidth: scene.drawingBufferWidth,
          drawingBufferHeight: scene.drawingBufferHeight,
        },
        mode: SceneMode.SCENE3D,
        commandList: [],
        cullingVolume: jasmine.createSpyObj("CullingVolume", [
          "computeVisibility",
        ]),
        afterRender: [],
        pixelRatio: 1.0,

        verticalExaggeration: 1.0,
        verticalExaggerationRelativeHeight: 0.0,

        globeTranslucencyState: new GlobeTranslucencyState(),
      };

      frameState.cullingVolume.computeVisibility.and.returnValue(
        Intersect.INTERSECTING,
      );

      imageryLayerCollection = new ImageryLayerCollection();
      surfaceShaderSet = jasmine.createSpyObj("SurfaceShaderSet", [
        "getShaderProgram",
      ]);
      mockTerrain = new MockTerrainProvider();
      tileProvider = new GlobeSurfaceTileProvider({
        terrainProvider: mockTerrain,
        imageryLayers: imageryLayerCollection,
        surfaceShaderSet: surfaceShaderSet,
      });
      quadtree = new QuadtreePrimitive({
        tileProvider: tileProvider,
      });

      processor = new TerrainTileProcessor(
        frameState,
        mockTerrain,
        imageryLayerCollection,
      );

      quadtree.render(frameState);
      rootTiles = quadtree._levelZeroTiles;

      processor.mockWebGL();
    });

    function process(quadtreePrimitive, callback) {
      return new Promise((resolve) => {
        function next() {
          ++frameState.frameNumber;
          quadtree.beginFrame(frameState);
          quadtree.render(frameState);
          quadtree.endFrame(frameState);

          if (callback()) {
            setTimeout(next, 0);
          } else {
            resolve();
          }
        }
        next();
      });
    }

    it("must be constructed with a tileProvider", function () {
      expect(function () {
        return new QuadtreePrimitive();
      }).toThrowDeveloperError();

      expect(function () {
        return new QuadtreePrimitive({});
      }).toThrowDeveloperError();
    });

    it("selects nothing when the root tiles are not yet ready", function () {
      quadtree.render(frameState);
      expect(quadtree._tilesToRender.length).toBe(0);
    });

    it("selects root tiles once they are ready", function () {
      mockTerrain
        .requestTileGeometryWillSucceed(rootTiles[0])
        .requestTileGeometryWillSucceed(rootTiles[1])
        .createMeshWillSucceed(rootTiles[0])
        .createMeshWillSucceed(rootTiles[1]);

      return processor.process(rootTiles).then(function () {
        quadtree.render(frameState);

        // There should be at least one selected tile.
        expect(quadtree._tilesToRender.length).toBeGreaterThan(0);

        // All selected tiles should be root tiles.
        expect(
          quadtree._tilesToRender.filter(function (tile) {
            return tile.level === 0;
          }).length,
        ).toBe(quadtree._tilesToRender.length);
      });
    });

    it("selects deeper tiles once they are renderable", function () {
      mockTerrain
        .requestTileGeometryWillSucceed(rootTiles[0])
        .requestTileGeometryWillSucceed(rootTiles[1])
        .createMeshWillSucceed(rootTiles[0])
        .createMeshWillSucceed(rootTiles[1]);

      rootTiles[0].children.forEach(function (tile) {
        mockTerrain
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);
        expect(tile.renderable).toBe(false);
      });

      return processor
        .process(rootTiles)
        .then(function () {
          quadtree.render(frameState);

          // All selected tiles should be root tiles.
          expect(quadtree._tilesToRender.length).toBeGreaterThan(0);
          expect(
            quadtree._tilesToRender.filter(function (tile) {
              return tile.level === 0;
            }).length,
          ).toBe(quadtree._tilesToRender.length);

          // Allow the child tiles to load.
          return processor.process(rootTiles[0].children);
        })
        .then(function () {
          quadtree.render(frameState);

          // Now child tiles should be rendered too.
          expect(quadtree._tilesToRender).toContain(
            rootTiles[0].southwestChild,
          );
          expect(quadtree._tilesToRender).toContain(
            rootTiles[0].southeastChild,
          );
          expect(quadtree._tilesToRender).toContain(
            rootTiles[0].northwestChild,
          );
          expect(quadtree._tilesToRender).toContain(
            rootTiles[0].northeastChild,
          );
        });
    });

    it("skips loading levels when tiles are known to be available", function () {
      // Mark all tiles through level 2 as available.
      rootTiles.forEach(function (tile) {
        // level 0 tile
        mockTerrain
          .willBeAvailable(tile)
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);

        tile.children.forEach(function (tile) {
          // level 1 tile
          mockTerrain
            .willBeAvailable(tile)
            .requestTileGeometryWillSucceed(tile)
            .createMeshWillSucceed(tile);

          tile.children.forEach(function (tile) {
            // level 2 tile
            mockTerrain
              .willBeAvailable(tile)
              .requestTileGeometryWillSucceed(tile)
              .createMeshWillSucceed(tile);
          });
        });
      });

      quadtree.preloadAncestors = false;

      // Look down at the center of a level 2 tile from a distance that will refine to it.
      const lookAtTile = rootTiles[0].southwestChild.northeastChild;
      setCameraPosition(
        quadtree,
        frameState,
        Rectangle.center(lookAtTile.rectangle),
        lookAtTile.level,
      );

      spyOn(mockTerrain, "requestTileGeometry").and.callThrough();

      return process(quadtree, function () {
        // Process until the lookAtTile is rendered. That tile's parent (level 1)
        // should not be rendered along the way.
        expect(quadtree._tilesToRender).not.toContain(lookAtTile.parent);
        const lookAtTileRendered =
          quadtree._tilesToRender.indexOf(lookAtTile) >= 0;
        const continueProcessing = !lookAtTileRendered;
        return continueProcessing;
      }).then(function () {
        // The lookAtTile should be a real tile, not a fill.
        expect(quadtree._tilesToRender).toContain(lookAtTile);
        expect(lookAtTile.data.fill).toBeUndefined();
        expect(lookAtTile.data.vertexArray).toBeDefined();

        // The parent of the lookAtTile should not have been requested.
        const parent = lookAtTile.parent;
        mockTerrain.requestTileGeometry.calls
          .allArgs()
          .forEach(function (call) {
            expect(call.slice(0, 3)).not.toEqual([
              parent.x,
              parent.y,
              parent.level,
            ]);
          });
      });
    });

    it("does not skip loading levels if availability is unknown", function () {
      // Mark all tiles through level 2 as available.
      rootTiles.forEach(function (tile) {
        // level 0 tile
        mockTerrain
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);

        tile.children.forEach(function (tile) {
          // level 1 tile
          mockTerrain
            .willBeAvailable(tile)
            .requestTileGeometryWillSucceed(tile)
            .createMeshWillSucceed(tile);

          tile.children.forEach(function (tile) {
            // level 2 tile
            mockTerrain
              .willBeUnknownAvailability(tile)
              .requestTileGeometryWillSucceed(tile)
              .createMeshWillSucceed(tile);
          });
        });
      });

      quadtree.preloadAncestors = false;

      // Look down at the center of a level 2 tile from a distance that will refine to it.
      const lookAtTile = rootTiles[0].southwestChild.northeastChild;
      setCameraPosition(
        quadtree,
        frameState,
        Rectangle.center(lookAtTile.rectangle),
        lookAtTile.level,
      );

      spyOn(mockTerrain, "requestTileGeometry").and.callThrough();

      return process(quadtree, function () {
        // Process until the lookAtTile is rendered. That tile's parent (level 1)
        // should not be rendered along the way, but it will be loaded.
        expect(quadtree._tilesToRender).not.toContain(lookAtTile.parent);
        const lookAtTileRendered =
          quadtree._tilesToRender.indexOf(lookAtTile) >= 0;
        const continueProcessing = !lookAtTileRendered;
        return continueProcessing;
      }).then(function () {
        // The lookAtTile should be a real tile, not a fill.
        expect(quadtree._tilesToRender).toContain(lookAtTile);
        expect(lookAtTile.data.fill).toBeUndefined();
        expect(lookAtTile.data.vertexArray).toBeDefined();

        // The parent of the lookAtTile should have been requested before the lookAtTile itself.
        const parent = lookAtTile.parent;
        const allArgs = mockTerrain.requestTileGeometry.calls.allArgs();
        const parentArgsIndex = allArgs.indexOf(
          allArgs.filter(function (call) {
            return (
              call[0] === parent.x &&
              call[1] === parent.y &&
              call[2] === parent.level
            );
          })[0],
        );
        const lookAtArgsIndex = allArgs.indexOf(
          allArgs.filter(function (call) {
            return (
              call[0] === lookAtTile.x &&
              call[1] === lookAtTile.y &&
              call[2] === lookAtTile.level
            );
          })[0],
        );
        expect(parentArgsIndex).toBeLessThan(lookAtArgsIndex);
      });
    });

    it("loads and renders intermediate tiles according to loadingDescendantLimit", function () {
      // Mark all tiles through level 2 as available.
      rootTiles.forEach(function (tile) {
        // level 0 tile
        mockTerrain
          .willBeAvailable(tile)
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);

        tile.children.forEach(function (tile) {
          // level 1 tile
          mockTerrain
            .willBeAvailable(tile)
            .requestTileGeometryWillSucceed(tile)
            .createMeshWillSucceed(tile);

          tile.children.forEach(function (tile) {
            // level 2 tile
            mockTerrain
              .willBeAvailable(tile)
              .requestTileGeometryWillSucceed(tile)
              .createMeshWillSucceed(tile);
          });
        });
      });

      quadtree.preloadAncestors = false;
      quadtree.loadingDescendantLimit = 1;

      // Look down at the center of a level 2 tile from a distance that will refine to it.
      const lookAtTile = rootTiles[0].southwestChild.northeastChild;
      setCameraPosition(
        quadtree,
        frameState,
        Rectangle.center(lookAtTile.rectangle),
        lookAtTile.level,
      );

      spyOn(mockTerrain, "requestTileGeometry").and.callThrough();

      return process(quadtree, function () {
        // First the lookAtTile's parent should be rendered.
        const lookAtTileParentRendered =
          quadtree._tilesToRender.indexOf(lookAtTile.parent) >= 0;
        const continueProcessing = !lookAtTileParentRendered;
        return continueProcessing;
      })
        .then(function () {
          // The lookAtTile's parent should be a real tile, not a fill.
          expect(quadtree._tilesToRender).toContain(lookAtTile.parent);
          expect(lookAtTile.parent.data.fill).toBeUndefined();
          expect(lookAtTile.parent.data.vertexArray).toBeDefined();

          return process(quadtree, function () {
            // Then the lookAtTile should be rendered.
            const lookAtTileRendered =
              quadtree._tilesToRender.indexOf(lookAtTile) >= 0;
            const continueProcessing = !lookAtTileRendered;
            return continueProcessing;
          });
        })
        .then(function () {
          // The lookAtTile should be a real tile, not a fill.
          expect(quadtree._tilesToRender).toContain(lookAtTile);
          expect(lookAtTile.data.fill).toBeUndefined();
          expect(lookAtTile.data.vertexArray).toBeDefined();
        });
    });

    it("continues rendering more detailed tiles when camera zooms out and an appropriate ancestor is not yet renderable", function () {
      // Mark all tiles through level 2 as available.
      rootTiles.forEach(function (tile) {
        // level 0 tile
        mockTerrain
          .willBeAvailable(tile)
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);

        tile.children.forEach(function (tile) {
          // level 1 tile
          mockTerrain
            .willBeAvailable(tile)
            .requestTileGeometryWillSucceed(tile)
            .createMeshWillSucceed(tile);

          tile.children.forEach(function (tile) {
            // level 2 tile
            mockTerrain
              .willBeAvailable(tile)
              .requestTileGeometryWillSucceed(tile)
              .createMeshWillSucceed(tile);
          });
        });
      });

      quadtree.preloadAncestors = false;

      // Look down at the center of a level 2 tile from a distance that will refine to it.
      const lookAtTile = rootTiles[0].southwestChild.northeastChild;
      setCameraPosition(
        quadtree,
        frameState,
        Rectangle.center(lookAtTile.rectangle),
        lookAtTile.level,
      );

      spyOn(mockTerrain, "requestTileGeometry").and.callThrough();

      return process(quadtree, function () {
        // Process until the lookAtTile is rendered. That tile's parent (level 1)
        // should not be rendered along the way.
        expect(quadtree._tilesToRender).not.toContain(lookAtTile.parent);
        const lookAtTileRendered =
          quadtree._tilesToRender.indexOf(lookAtTile) >= 0;
        const continueProcessing = !lookAtTileRendered;
        return continueProcessing;
      })
        .then(function () {
          // Zoom out so the parent tile no longer needs to refine to meet SSE.
          setCameraPosition(
            quadtree,
            frameState,
            Rectangle.center(lookAtTile.rectangle),
            lookAtTile.parent.level,
          );

          // Select new tiles
          quadtree.beginFrame(frameState);
          quadtree.render(frameState);
          quadtree.endFrame(frameState);

          // The lookAtTile should still be rendered, not it's parent.
          expect(quadtree._tilesToRender).toContain(lookAtTile);
          expect(quadtree._tilesToRender).not.toContain(lookAtTile.parent);

          return process(quadtree, function () {
            // Eventually the parent should be rendered instead.
            const parentRendered =
              quadtree._tilesToRender.indexOf(lookAtTile.parent) >= 0;
            const continueProcessing = !parentRendered;
            return continueProcessing;
          });
        })
        .then(function () {
          expect(quadtree._tilesToRender).not.toContain(lookAtTile);
          expect(quadtree._tilesToRender).toContain(lookAtTile.parent);
        });
    });

    it("renders a fill for a newly-visible tile", function () {
      // Mark all tiles through level 2 as available.
      rootTiles.forEach(function (tile) {
        // level 0 tile
        mockTerrain
          .willBeAvailable(tile)
          .requestTileGeometryWillSucceed(tile)
          .createMeshWillSucceed(tile);

        tile.children.forEach(function (tile) {
          // level 1 tile
          mockTerrain
            .willBeAvailable(tile)
            .requestTileGeometryWillSucceed(tile)
            .createMeshWillSucceed(tile);

          tile.children.forEach(function (tile) {
            // level 2 tile
            mockTerrain
              .willBeAvailable(tile)
              .requestTileGeometryWillSucceed(tile)
              .createMeshWillSucceed(tile);
          });
        });
      });

      quadtree.preloadAncestors = false;

      const visibleTile = rootTiles[0].southwestChild.northeastChild;
      const notVisibleTile = rootTiles[0].southwestChild.northwestChild;

      frameState.cullingVolume.computeVisibility.and.callFake(
        function (boundingVolume) {
          if (!defined(visibleTile.data)) {
            return Intersect.INTERSECTING;
          }

          if (
            boundingVolume ===
            visibleTile.data.tileBoundingRegion.boundingVolume
          ) {
            return Intersect.INTERSECTING;
          } else if (
            boundingVolume ===
            notVisibleTile.data.tileBoundingRegion.boundingVolume
          ) {
            return Intersect.OUTSIDE;
          }
          return Intersect.INTERSECTING;
        },
      );

      // Look down at the center of the visible tile.
      setCameraPosition(
        quadtree,
        frameState,
        Rectangle.center(visibleTile.rectangle),
        visibleTile.level,
      );

      spyOn(mockTerrain, "requestTileGeometry").and.callThrough();

      return process(quadtree, function () {
        // Process until the visibleTile is rendered.
        const visibleTileRendered =
          quadtree._tilesToRender.indexOf(visibleTile) >= 0;
        const continueProcessing = !visibleTileRendered;
        return continueProcessing;
      }).then(function () {
        expect(quadtree._tilesToRender).not.toContain(notVisibleTile);

        // Now treat the not-visible-tile as visible.
        frameState.cullingVolume.computeVisibility.and.returnValue(
          Intersect.INTERSECTING,
        );

        // Select new tiles
        quadtree.beginFrame(frameState);
        quadtree.render(frameState);
        quadtree.endFrame(frameState);

        // The notVisibleTile should be rendered as a fill.
        expect(quadtree._tilesToRender).toContain(visibleTile);
        expect(quadtree._tilesToRender).toContain(notVisibleTile);
        expect(notVisibleTile.data.fill).toBeDefined();
        expect(notVisibleTile.data.vertexArray).toBeUndefined();
      });
    });
  });

  describe(
    "with mock tile provider",
    function () {
      let scene;

      beforeAll(function () {
        scene = createScene();
        scene.render();
      });

      afterAll(function () {
        scene.destroyForSpecs();
      });

      function createSpyTileProvider() {
        const result = jasmine.createSpyObj("tileProvider", [
          "getQuadtree",
          "setQuadtree",
          "getReady",
          "getTilingScheme",
          "getErrorEvent",
          "initialize",
          "updateImagery",
          "beginUpdate",
          "endUpdate",
          "getLevelMaximumGeometricError",
          "loadTile",
          "computeTileVisibility",
          "showTileThisFrame",
          "computeDistanceToTile",
          "canRefine",
          "isDestroyed",
          "destroy",
        ]);

        Object.defineProperties(result, {
          quadtree: {
            get: result.getQuadtree,
            set: result.setQuadtree,
          },
          tilingScheme: {
            get: result.getTilingScheme,
          },
          errorEvent: {
            get: result.getErrorEvent,
          },
        });

        const tilingScheme = new GeographicTilingScheme();
        result.getTilingScheme.and.returnValue(tilingScheme);

        result.canRefine.and.callFake(function (tile) {
          return tile.renderable;
        });

        return result;
      }

      it("calls initialize, beginUpdate, loadTile, and endUpdate", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expect(tileProvider.initialize).toHaveBeenCalled();
        expect(tileProvider.beginUpdate).toHaveBeenCalled();
        expect(tileProvider.loadTile).toHaveBeenCalled();
        expect(tileProvider.endUpdate).toHaveBeenCalled();
      });

      it("shows the root tiles when they are ready and visible", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.renderable = true;
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expect(tileProvider.showTileThisFrame).toHaveBeenCalled();
      });

      it("stops loading a tile that moves to the DONE state", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);

        let calls = 0;
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          ++calls;
          tile.state = QuadtreeTileLoadState.DONE;
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expect(calls).toBe(2);

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expect(calls).toBe(2);
      });

      it("tileLoadProgressEvent is raised when tile loaded and when new children discovered", function () {
        const eventHelper = new EventHelper();

        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        const progressEventSpy = jasmine.createSpy("progressEventSpy");
        eventHelper.add(quadtree.tileLoadProgressEvent, progressEventSpy);

        // Initial update to get the zero-level tiles set up.
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load zero-level tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        quadtree.update(scene.frameState);

        scene.renderForSpecs();

        // There will now be two zero-level tiles in the load queue.
        expect(progressEventSpy.calls.mostRecent().args[0]).toEqual(2);

        // Change one to loaded and update again
        quadtree._levelZeroTiles[0].state = QuadtreeTileLoadState.DONE;
        quadtree._levelZeroTiles[1].state = QuadtreeTileLoadState.LOADING;

        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        quadtree.update(scene.frameState);

        scene.renderForSpecs();

        // Now there should only be one left in the update queue
        expect(progressEventSpy.calls.mostRecent().args[0]).toEqual(1);

        // Simulate the second zero-level child having loaded with two children.
        quadtree._levelZeroTiles[1].state = QuadtreeTileLoadState.DONE;
        quadtree._levelZeroTiles[1].renderable = true;

        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        quadtree.update(scene.frameState);

        scene.renderForSpecs();

        // Now that tile's four children should be in the load queue.
        expect(progressEventSpy.calls.mostRecent().args[0]).toEqual(4);
      });

      it("forEachLoadedTile does not enumerate tiles in the START state", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);
        tileProvider.computeDistanceToTile.and.returnValue(1e-15);

        // Load the root tiles.
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.state = QuadtreeTileLoadState.DONE;
          tile.renderable = true;
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // Don't load further tiles.
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.state = QuadtreeTileLoadState.START;
        });

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        quadtree.forEachLoadedTile(function (tile) {
          expect(tile.state).not.toBe(QuadtreeTileLoadState.START);
        });
      });

      it("add and remove callbacks to tiles", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);
        tileProvider.computeDistanceToTile.and.returnValue(1e-15);

        // Load the root tiles.
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.state = QuadtreeTileLoadState.DONE;
          tile.renderable = true;
          tile.data = {
            pick: function () {
              return undefined;
            },
          };
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        const removeFunc = quadtree.updateHeight(
          Cartographic.fromDegrees(-72.0, 40.0),
          function (position) {},
        );

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        ++scene.frameState.frameNumber;

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        let addedCallback = false;
        quadtree.forEachLoadedTile(function (tile) {
          addedCallback = addedCallback || tile.customData.length > 0;
        });

        expect(addedCallback).toEqual(true);

        removeFunc();

        ++scene.frameState.frameNumber;

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        let removedCallback = true;
        quadtree.forEachLoadedTile(function (tile) {
          removedCallback = removedCallback && tile.customData.length === 0;
        });

        expect(removedCallback).toEqual(true);
      });

      it("updates heights", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);
        tileProvider.computeDistanceToTile.and.returnValue(1e-15);

        tileProvider.terrainProvider = {
          getTileDataAvailable: function () {
            return true;
          },
        };

        const positionCarto = Cartographic.fromDegrees(-72.0, 40.0, 0);
        const updatedPositionCarto = Cartographic.fromDegrees(-72.0, 40.0, 100);
        const position = Cartographic.toCartesian(positionCarto);
        const updatedPosition = Cartographic.toCartesian(updatedPositionCarto);
        // variables for results
        const positionRes = new Cartographic();
        const updatedPositionRes = new Cartographic();
        let currentPosition = position;
        let currentPositionRes = positionRes;

        // Load the root tiles.
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.state = QuadtreeTileLoadState.DONE;
          tile.renderable = true;
          tile.data = {
            pick: function () {
              return currentPosition;
            },
            mesh: {},
          };
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        quadtree.updateHeight(
          Cartographic.fromDegrees(-72.0, 40.0),
          function (p) {
            // p is a Cartographic position
            Cartographic.clone(p, currentPositionRes);
          },
        );

        // determine what tiles to load
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // load tiles
        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expectCartographicToEqualEpsilon(
          positionRes,
          positionCarto,
          CesiumMath.EPSILON10,
        );

        currentPosition = updatedPosition;
        currentPositionRes = updatedPositionRes;

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expectCartographicToEqualEpsilon(
          updatedPositionRes,
          updatedPositionCarto,
          CesiumMath.EPSILON10,
        );
      });

      it("uses tiles position caching in update heights", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);
        tileProvider.computeDistanceToTile.and.returnValue(1e-15);

        tileProvider.terrainProvider = {
          getTileDataAvailable: function () {
            return true;
          },
        };

        // Dummy positions
        const computedPosition = new Cartesian3(1000, 2000, 3000);
        const currentPosition = computedPosition;

        // Create a Map to count how many times the tile's pick function is called for each tile level.
        const pickCounters = new Map();

        // Load the root tiles.
        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          tile.state = QuadtreeTileLoadState.DONE;
          tile.renderable = true;
          tile.data = {
            // The pick function simulates computing a clamped position.
            // Each call increments the counter.
            pick: function () {
              // Initialize the counter for this tile's level if not already set.
              if (!pickCounters.has(tile.level)) {
                pickCounters.set(tile.level, 0);
              }
              const count = pickCounters.get(tile.level);
              const pickPosition = currentPosition;
              pickCounters.set(tile.level, count + 1);
              return pickPosition;
            },
            mesh: {},
          };
        });

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        // Create two nearly identical cartographic positions (in degrees)
        const carto1 = Cartographic.fromDegrees(-72.0, 40.0);
        // Slightly offset cartographic coordinates (within the rounding tolerance)
        const carto2 = Cartographic.fromDegrees(
          -72.0 + 0.000001,
          40.0 + 0.000001,
        );

        // Variables to store results from the callbacks
        const position1 = new Cartographic();
        const position2 = new Cartographic();

        // Install two height update callbacks with near-identical positions.
        quadtree.updateHeight(carto1, function (p) {
          Cartographic.clone(p, position1);
        });
        quadtree.updateHeight(carto2, function (p) {
          Cartographic.clone(p, position2);
        });

        // Process a few render cycles to trigger height updates and cache usage.
        for (let i = 0; i < 3; ++i) {
          quadtree.update(scene.frameState);
          quadtree.beginFrame(scene.frameState);
          quadtree.render(scene.frameState);
          quadtree.endFrame(scene.frameState);
        }

        // Verify that for each tile level recorded in pickCounters, the pick function was called only once.
        pickCounters.forEach((count, level) => {
          expect(count).toEqual(1);
        });

        // Verify that both callbacks produced the same computed position (indicating a cache hit).
        expect(position1).toEqual(position2);
      });

      it("gives correct priority to tile loads", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // The root tiles should be in the high priority load queue
        expect(quadtree._tileLoadQueueHigh.length).toBe(2);
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[1],
        );
        expect(quadtree._tileLoadQueueMedium.length).toBe(0);
        expect(quadtree._tileLoadQueueLow.length).toBe(0);

        // Mark the first root tile renderable (but not done loading)
        quadtree._levelZeroTiles[0].renderable = true;

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // That root tile should now load with low priority while its children should load with high.
        expect(quadtree._tileLoadQueueHigh.length).toBe(5);
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[1],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[0],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[1],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[2],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[3],
        );
        expect(quadtree._tileLoadQueueMedium.length).toBe(0);
        expect(quadtree._tileLoadQueueLow.length).toBe(1);
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0],
        );

        // Mark the children of that root tile renderable too, so we can refine it
        quadtree._levelZeroTiles[0].children[0].renderable = true;
        quadtree._levelZeroTiles[0].children[1].renderable = true;
        quadtree._levelZeroTiles[0].children[2].renderable = true;
        quadtree._levelZeroTiles[0].children[3].renderable = true;

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        expect(quadtree._tileLoadQueueHigh.length).toBe(17); // levelZeroTiles[1] plus levelZeroTiles[0]'s 16 grandchildren
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[1],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[0].children[0],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[0].children[1],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[0].children[2],
        );
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[0].children[0].children[3],
        );
        expect(quadtree._tileLoadQueueMedium.length).toBe(0);
        expect(quadtree._tileLoadQueueLow.length).toBe(5);
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0],
        );
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0].children[0],
        );
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0].children[1],
        );
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0].children[2],
        );
        expect(quadtree._tileLoadQueueLow).toContain(
          quadtree._levelZeroTiles[0].children[3],
        );

        // Mark the children of levelZeroTiles[0] upsampled
        quadtree._levelZeroTiles[0].children[0].upsampledFromParent = true;
        quadtree._levelZeroTiles[0].children[1].upsampledFromParent = true;
        quadtree._levelZeroTiles[0].children[2].upsampledFromParent = true;
        quadtree._levelZeroTiles[0].children[3].upsampledFromParent = true;

        quadtree.update(scene.frameState);
        quadtree.beginFrame(scene.frameState);
        quadtree.render(scene.frameState);
        quadtree.endFrame(scene.frameState);

        // levelZeroTiles[0] should move to medium priority.
        expect(quadtree._tileLoadQueueHigh.length).toBe(1);
        expect(quadtree._tileLoadQueueHigh).toContain(
          quadtree._levelZeroTiles[1],
        );
        expect(quadtree._tileLoadQueueMedium.length).toBe(1);
        expect(quadtree._tileLoadQueueMedium).toContain(
          quadtree._levelZeroTiles[0],
        );
        expect(quadtree._tileLoadQueueLow.length).toBe(0);
      });

      it("renders tiles in approximate near-to-far order", function () {
        const tileProvider = createSpyTileProvider();
        tileProvider.getReady.and.returnValue(true);
        tileProvider.computeTileVisibility.and.returnValue(Visibility.FULL);

        const quadtree = new QuadtreePrimitive({
          tileProvider: tileProvider,
        });

        tileProvider.loadTile.and.callFake(function (frameState, tile) {
          if (tile.level <= 1) {
            tile.state = QuadtreeTileLoadState.DONE;
            tile.renderable = true;
          }
        });

        scene.camera.setView({
          destination: Cartesian3.fromDegrees(1.0, 1.0, 15000.0),
        });
        scene.camera.update(scene.mode);

        return pollToPromise(function () {
          quadtree.update(scene.frameState);
          quadtree.beginFrame(scene.frameState);
          quadtree.render(scene.frameState);
          quadtree.endFrame(scene.frameState);

          return (
            quadtree._tilesToRender.filter(function (tile) {
              return tile.level === 1;
            }).length === 8
          );
        }).then(function () {
          quadtree.update(scene.frameState);
          quadtree.beginFrame(scene.frameState);
          quadtree.render(scene.frameState);
          quadtree.endFrame(scene.frameState);

          // Rendered tiles:
          // +----+----+----+----+
          // |w.nw|w.ne|e.nw|e.ne|
          // +----+----+----+----+
          // |w.sw|w.se|e.sw|e.se|
          // +----+----+----+----+
          // camera is located in e.nw (east.northwestChild)

          const west = quadtree._levelZeroTiles.filter(function (tile) {
            return tile.x === 0;
          })[0];
          const east = quadtree._levelZeroTiles.filter(function (tile) {
            return tile.x === 1;
          })[0];
          expect(quadtree._tilesToRender[0]).toBe(east.northwestChild);
          expect(
            quadtree._tilesToRender[1] === east.southwestChild ||
              quadtree._tilesToRender[1] === east.northeastChild,
          ).toBe(true);
          expect(
            quadtree._tilesToRender[2] === east.southwestChild ||
              quadtree._tilesToRender[2] === east.northeastChild,
          ).toBe(true);
          expect(quadtree._tilesToRender[3]).toBe(east.southeastChild);
          expect(quadtree._tilesToRender[4]).toBe(west.northeastChild);
          expect(
            quadtree._tilesToRender[5] === west.northwestChild ||
              quadtree._tilesToRender[5] === west.southeastChild,
          ).toBe(true);
          expect(
            quadtree._tilesToRender[6] === west.northwestChild ||
              quadtree._tilesToRender[6] === west.southeastChild,
          ).toBe(true);
          expect(quadtree._tilesToRender[7]).toBe(west.southwestChild);
        });
      });
    },
    "WebGL",
  );

  // Sets the camera to look at a given cartographic position from a distance
  // that will produce a screen-space error at that position that will refine to
  // a given tile level and no further.
  function setCameraPosition(quadtree, frameState, position, level) {
    const camera = frameState.camera;
    const geometricError =
      quadtree.tileProvider.getLevelMaximumGeometricError(level);
    const sse = quadtree.maximumScreenSpaceError * 0.8;
    const sseDenominator = camera.frustum.sseDenominator;
    const height = frameState.context.drawingBufferHeight;

    const distance = (geometricError * height) / (sse * sseDenominator);
    const cartesian = Ellipsoid.WGS84.cartographicToCartesian(position);
    camera.lookAt(cartesian, new Cartesian3(0.0, 0.0, distance));
  }
});
