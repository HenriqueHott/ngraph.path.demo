module.exports = getSettings

function getSettings(qs) {
  const graphSettings = getAvailableGraphs(qs); 
  const pathFinderSettings = getAvailablePathfinders(qs); 

  return {
    graphSettings,
    pathFinderSettings
  };
}

function getAvailableGraphs(qs) {
  let graphs = [{
    value: 'bh',
    name: 'bh (120K vértices, 1.7 MB)'
  }
];

  return {
    selected: qs.get('graph'),
    graphs
  };
}

function getAvailablePathfinders(qs) {
  return {
    selected: qs.get('finder') || 'nba',
    algorithms: [{
      value: 'a-greedy-star',
      name: 'Greedy A* (suboptimal)'
    }, {
      value: 'nba',
      name: 'NBA*'
    }, {
      value: 'astar-uni',
      name: 'Unidirectional A*'
    }, {
      value: 'dijkstra',
      name: 'Dijkstra'
    }]
  };
}