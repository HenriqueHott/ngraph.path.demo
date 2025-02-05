/**
 * This is the main application model.
 */
const createTree = require('yaqt');
const npath = require('ngraph.path'); // the pathfinders

const loadGraph = require('./lib/loadGraph'); // loads graph asynchronously
const Progress = require('./lib/Progress'); // notifies UI about loading progress

// This is a state for two dots A and B on the UI
const RouteHandleViewModel = require('./lib/RouteHandleViewModel');

// We use a few options in the UI (available path finders, available graphs)
const getSettings = require('./settings.js')

// Some state is shared in the query string (start/end of the route)
const queryState = require('query-state');

// And this is how the state communicates asynchronously with App.vue
const bus = require('./bus');

// Now that we are done with imports, lets initialize the state.

// First of all, read what we currently have in the query string.
const qs = queryState({
  graph: 'bh'
});

qs.onChange(updateStateFromQueryString);

let graph;      // current graph
let graphBBox;  // current bounding box for a graph
let hetTestTree;       // this tree helps us find graph node under cursor
let pathFinder;        // currently selected pathfinder
let pathFindersLookup; // initialized after we load graph

let pendingQueryStringUpdate = 0; // Used to throttle query string updates.

let routeStart = new RouteHandleViewModel(()=>{}, findNearestPoint);
let routeEnd = new RouteHandleViewModel(()=>{}, findNearestPoint);
let routes = [];

let finishedCalculating;

let stats = {
  visible: false,
  lastSearchTook: 0,
  pathLength: 0,
  graphNodeCount: '',
  graphLinksCount: ''
};

let settings = getSettings(qs);

const api = {
  loadPositions,

  updateSearchAlgorithm,
  updateSelectedGraph,

  getGraph,
  getGraphBBox,

  progress: new Progress(),
  stats,

  routeStart, 
  routeEnd,
  routes,
  finishedCalculating,
  pathInfo: {
    svgPath: '',
    noPath: false
  },

  handleSceneClick,
  getRouteHandleUnderCursor,
  clearRoute,
  calculate,

  pathFinderSettings: settings.pathFinderSettings,
  graphSettings: settings.graphSettings
}

module.exports = api;

// The app model is ready at this point.

function updateStateFromQueryString(queryState) {
  let searchChanged = (queryState.fromId !== routeStart.pointId) || 
                      (queryState.toId !== routeEnd.pointId);

  if (searchChanged) {
    setCurrentSearchFromQueryState();
    updateRoute();
  }
}


/**
 * This method sets a new pathfinder, according to currently selected
 * drop down option from `pathFinderSettings`
 */
function updateSearchAlgorithm() {
  setCurrentPathFinder();
  qs.set('finder', settings.pathFinderSettings.selected);
  updateRoute();
}

function getRouteHandleUnderCursor(e, scene) {
  let transform = scene.getTransform();
  let scale = transform.scale/scene.getPixelRatio();

  if (routeStart.intersects(e.sceneX, e.sceneY, scale)) {
    return routeStart;
  }
  if (routeEnd.intersects(e.sceneX, e.sceneY, scale)) {
    return routeEnd;
  }
}

function getGraphBBox() {
  return graphBBox;
}

function updateRoute() {
  let routesVisible = true;
  routes.forEach(route => routesVisible = routesVisible && route.visible)

  if (!(routes.length > 1 && routesVisible)) {
    api.pathInfo.svgPath = '';
    return;
  }

  let start = window.performance.now();

  // Calcular melhor rota utilizando heuristica de otimizacao
  let bestRoute = calculateBestRoute();
  let path = bestRoute.path;
  
  let end = window.performance.now() - start;

  api.pathInfo.noPath = path.length === 0;
  api.pathInfo.svgPath = getSvgPath(path);

  stats.lastSearchTook = (Math.round(end * 100)/100) + 'ms';
  stats.pathLength = bestRoute.pathLength;
  stats.visible = true;
}

function calculateBestRoute() {
  let completeGraph = [];

  routes.forEach((item, index) => {
    completeGraph[index] = [];
    routes.forEach((item2, index2) => {
      completeGraph[index][index2] = index == index2 ? Number.MAX_SAFE_INTEGER : getPathLength(findPath(item.pointId, item2.pointId)); 
    });
  });

  let permutations = [];
  for (let i = 1; i <= routes.length-1; i++) {
    permutations.push(i);
  }

  permutations = getArrayPermutations(permutations);
  permutations.forEach((item) => {
    item.unshift(0);
    item.push(0);
  });

  let result = [];
  permutations.forEach((option) => {
    let path = [];

    for(let i = 0; i + 1 < option.length; i++) {
      let fromId = routes[option[i]].pointId;
      let toId = routes[option[i + 1]].pointId;

      path = path.concat(findPath(fromId, toId).reverse());
    }
    let pathLength = getPathLength(path); 
    result.push({path, pathLength});

  });

  var sortedResults = result.sort((a, b) => {
    return parseInt(a.pathLength.replace(",", "")) - parseInt(b.pathLength.replace(",", ""));
  });

  return sortedResults[0];
}

function getPathLength(path) {
  let totalLength = 0;
  for (let i = 1; i < path.length; ++i) {
    totalLength += dataDistance(path[i - 1], path[i]);
  }
  return numberWithCommas(Math.round(totalLength));
}

function clearRoute() {
  routes.forEach((element) => {
    element.clear();
  });
  routes.splice(0,routes.length);
  finishedCalculating = false;

  api.pathInfo.svgPath = "";
  qs.set({
    fromId: -1,
    toId: -1
  });
}

function calculate() {
  updateRoute();
  finishedCalculating = true;
}

function handleSceneClick(e) {
  if (!finishedCalculating) {
    routes.push(new RouteHandleViewModel(()=>{}, findNearestPoint));
    setRoutePointFormEvent(e, routes[routes.length-1]);
  }
}

function setRoutePointFormEvent(e, routePointViewModel) {
  if (!hetTestTree) return; // we are not initialized yet.

  let point = findNearestPoint(e.sceneX, e.sceneY)
  if (!point) throw new Error('Point should be defined at this moment');

  routePointViewModel.setFrom(point);
}

function loadPositions() {
  let graphName = qs.get('graph');
  hetTestTree = null;
  graph = null;
  stats.visible = false;
  api.progress.reset();

  loadGraph(graphName, api.progress).then(setApplicationModelVariables)
  .catch((e) => {
    api.progress.setError('Could not load the graph', e);
  });
}

function setApplicationModelVariables(loaded) {
  graph = loaded.graph;
  graphBBox = loaded.graphBBox;
  pathFinder = null;

  initHitTestTree(loaded.points);
  initPathfinders();

  stats.graphNodeCount = numberWithCommas(graph.getNodesCount());
  stats.graphLinksCount = numberWithCommas(graph.getLinksCount());
  bus.fire('graph-loaded')
  setTimeout(() => {
    // in case if we have path in the query string
    //updateRoute();
  }, 10);
}

function initHitTestTree(loadedPoints) {
  hetTestTree = createTree();
  hetTestTree.initAsync(loadedPoints, {
    progress(i, total) {
      if (i % 500 !== 0) return;

      api.progress.message = 'Initializing tree for point & click'
      api.progress.completed = Math.round(100 * i/total) + '%';
    },
    done() {
      api.progress.treeReady = true;
    }
  });
}



function initPathfinders() {
  pathFindersLookup = {
    'a-greedy-star': npath.aGreedy(graph, {
      distance: distance,
      heuristic: distance
    }),
    'nba': npath.nba(graph, {
      distance: distance,
      heuristic: distance
    }),
    'astar-uni': npath.aStar(graph, {
      distance: distance,
      heuristic: distance
    }),
    'dijkstra': npath.aStar(graph, {
      distance: distance
    }),
  }

  setCurrentPathFinder()
  setCurrentSearchFromQueryState();
}

function setCurrentPathFinder() {
  let pathFinderName = settings.pathFinderSettings.selected;
  pathFinder = pathFindersLookup[pathFinderName];
  if (!pathFinder) {
    throw new Error('Cannot find pathfinder ' + pathFinderName);
  }
}

function setCurrentSearchFromQueryState() {
  if (!graph) return;

  let fromId = qs.get('fromId');
  let toId = qs.get('toId');
  let from = graph.getNode(fromId)
  let to = graph.getNode(toId)
  if (from) routeStart.setFrom(from)
  if (to) routeEnd.setFrom(to)
}

function updateSelectedGraph() {
  qs.set({
    graph: settings.graphSettings.selected,
    fromId: -1,
    toId: -1
  });

  loadPositions();
  clearRoute();
}

function numberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function findPath(fromId, toId) {
  return pathFinder.find(fromId, toId).map(l => l.data);
}

function getSvgPath(points) {
  if (points.length < 1) return '';

  return points.map((pt, index) => {
    let prefix = (index === 0) ? 'M' : ''
    return prefix + toPoint(pt);
  }).join(' ');
}

function toPoint(p) { return p.x + ',' + p.y }

function getGraph() {
  return graph;
}

function findNearestPoint(x, y, maxDistanceToExplore = 2000) {
  if (!hetTestTree) return;

  let points = hetTestTree.pointsAround(x, y, maxDistanceToExplore).map(idx => graph.getNode(idx/2))
  .sort((a, b) => {
    let da = pointDistance(a.data, x, y);
    let db = pointDistance(b.data, x, y)
    return da - db;
  });

  if (points.length > 0) {
    return points[0];
  } else {
    // keep trying.
    return findNearestPoint(x, y, maxDistanceToExplore * 2);
  }
}

function pointDistance(src, x, y) {
  let dx = src.x - x;
  let dy = src.y - y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distance(a, b) {
  return dataDistance(a.data, b.data);
}

function dataDistance(a, b) {
  let dx = a.x - b.x;
  let dy = a.y - b.y;

  return Math.sqrt(dx * dx + dy * dy)
}

function getArrayPermutations(arr, perms = [], len = arr.length) {
  if (len === 1) perms.push(arr.slice(0))

  for (let i = 0; i < len; i++) {
    getArrayPermutations(arr, perms, len - 1)

    len % 2 // parity dependent adjacent elements swap
      ? [arr[0], arr[len - 1]] = [arr[len - 1], arr[0]]
      : [arr[i], arr[len - 1]] = [arr[len - 1], arr[i]]
  }

  return perms
}