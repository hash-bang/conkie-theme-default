// Imports {{{
var _ = require('lodash');
var $ = jQuery = require('jquery');
var angular = require('angular');
var electron = require('electron');
var moment = require('moment');
var sparklines = require('jquery-sparkline');
// }}}
// Replace console.log -> ipcRenderer.sendMessage('console') + original console.log {{{
console.logReal = console.log;
console.log = function() {
	var args = Array.prototype.slice.call(arguments, 0);

	electron.ipcRenderer.send.apply(this, ['console'].concat(args));
	console.logReal.apply(this, args);
};
// }}}


// User configurable options
var options = {
	chartPeriod: moment.duration(1, 'hour').as('milliseconds'), // How far backwards each chart should log - this period effectvely equals the X axis range
	chartPeriodCleanup: moment.duration(5, 'minutes').as('milliseconds'), // Clean up chart data periodically
	conkieStatsModules: [ // Modules we want Conkie stats to load
		'cpu',
		'dropbox',
		'io', // Also provides 'topIO'
		'memory',
		'net',
		'power',
		'system',
		'temperature',
		'topCPU',
		'topMemory',
	],
	conkieStats: { // Options passed to conkie-stats
		topProcessCount: 5,
		net: {
			ignoreNoIP: true,
			ignoreDevice: ['lo'],
		},
	},
	mainBattery: ['BAT0', 'BAT1'], // Which battery to examine for power info (the first one found gets bound to $scope.stats.battery)
	window: {
		left: -10,
		top: 40,
		width: 240,
		height: 1000,
	},
};



// Code only below this line - here be dragons
// -------------------------------------------


var app = angular.module('app', []);


// Angular / Filters {{{
/**
* Format a given number of seconds as a human readable duration
* e.g. 65 => '1m 5s'
* @param {number} value The number of seconds to process
* @return {string} The formatted value
*/
app.filter('duration', function() {
	return function(value) {
		if (!value || !isFinite(value)) return;

		var duration = moment.duration(value, 'seconds');
		if (!duration) return;

		var out = '';

		var years = duration.years();
		if (years) out += years + 'Y ';

		var months = duration.months();
		if (months) out += months + 'M ';

		var days = duration.days();
		if (days) out += days + 'd ';

		var hours = duration.hours();
		if (hours) out += hours + 'h ';

		var minutes = duration.minutes();
		if (minutes) out += minutes + 'm ';

		var seconds = duration.seconds();
		if (seconds) out += seconds + 's';

		return out;
	};
});


/**
* Return a formatted number as a file size
* e.g. 0 => 0B, 1024 => 1 kB
* @param {mixed} value The value to format
* @param {boolean} forceZero Whether the filter should return '0 B' if it doesnt know what to do
* @return {string} The formatted value
*/
app.filter('byteSize', function() {
	return function(value, forceZero) {
		if (!value || !isFinite(value)) return (forceZero ? '0 B' : null);

		var exponent;
		var unit;
		var neg = value < 0;
		var units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

		if (neg) {
			value = -value;
		}

		if (value < 1) {
			return (neg ? '-' : '') + value + ' B';
		}

		exponent = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
		value = (value / Math.pow(1000, exponent)).toFixed(2) * 1;
		unit = units[exponent];

		return (neg ? '-' : '') + value + ' ' + unit;
	};
});


/**
* Return a number as a formatted percentage
* @param {mixed} value The value to format
* @return {string} The formatted value
*/
app.filter('percent', function() {
	return function(value) {
		if (!value || !isFinite(value)) return '';

		return Math.round(value, 2) + '%';
	};
});

// }}}

app.directive('graph', function() {
	return {
		scope: {
			data: '=',
			config: '=',
		},
		restrict: 'E',
		template: '',
		controller: function($scope) {
			// Implied: $scope.elem;
			$scope.$watchCollection('data', function() {
				if (!$scope.elem || !$scope.data) return; // Element or data not bound yet
				$scope.elem.sparkline($scope.data, $scope.config);
			});
		},
		link: function($scope, elem, attr, ctrl) {
			$scope.elem = $(elem);
		},
	};
});

/**
* The main Conkie controller
* Each of the data feeds are exposed via the 'stats' structure and correspond to the output of [Conkie-Stats](https://github.com/hash-bang/Conkie-Stats)
*/
app.controller('conkieController', function($scope, $interval, $timeout) {
	// .stats - backend-IPC provided stats object {{{
	$scope.stats = {}; // Stats object (gets updated via IPC)

	electron.ipcRenderer
		// Event: updateStats {{{
		.on('updateStats', function(e, data) {
			$scope.$apply(function() {
				var now = new Date();
				$scope.stats = data;

				// Chart data updates {{{

				// .stats.power {{{
				if ($scope.stats.power) {
					$scope.stats.battery = $scope.stats.power.find(function(dev) {
						return (_.includes(options.mainBattery, dev.device));
					});
					if ($scope.stats.battery) $scope.charts.battery.data.push([now, $scope.stats.battery.percent]);
				}
				// }}}

				// .stats.io {{{
				if (_.has($scope.stats, 'io.totalRead') && isFinite($scope.stats.io.totalRead)) $scope.charts.io.data.push([now, $scope.stats.io.totalRead]);
				// }}}

				// .stats.memory {{{
				if (_.has($scope.stats, 'memory.used') && isFinite($scope.stats.memory.used)) {
					if ($scope.stats.memory.total) $scope.charts.memory.config.chartRangeMaxX = $scope.stats.memory.total;
					$scope.charts.memory.data.push([now, $scope.stats.memory.used]);
				}
				// }}}

				// .net {{{
				if ($scope.stats.net) {
					$scope.stats.net.forEach(function(adapter) {
						var id = adapter.interface; // Use the adapter interface name as the chart name
						// Not seen this adapter before - create a chart object {{{
						if (!$scope.charts[id]) {
							$scope.charts[id] = {
								data: [],
								config: $scope.charts.template.config,
							};
						}
						// }}}
						// Append bandwidth data to the chart {{{
						if (isFinite(adapter.downSpeed)) $scope.charts[id].data.push([now, adapter.downSpeed]);
						// if (isFinite(adapter.upSpeed)) $scope.charts[id].series[1].data.push([now, adapter.upSpeed]);

						if (($scope.charts[id].data.length % 100) == 0) console.log('APPEND stats', $scope.charts[id].data.length);
						// }}}
					});
				}
				// }}}

				// .stats.system {{{
				if (_.has($scope.stats, 'cpu.usage') && isFinite($scope.stats.cpu.usage)) $scope.charts.cpu.data.push([now, $scope.stats.cpu.usage]);
				// }}}

				// META: .stats.netTotal {{{
				if ($scope.stats.net) {
					$scope.stats.netTotal = $scope.stats.net.reduce(function(total, adapter) {
						if (adapter.downSpeed) total.downSpeed += adapter.downSpeed;
						if (adapter.upSpeed) total.upSpeed += adapter.upSpeed;
						return total;
					}, {
						downSpeed: 0,
						upSpeed: 0,
					});
				}
				// }}}
				// }}}

			});
		})
	// }}}
	// Configure conkie-stats to provide us with information {{{
	$timeout(function() {
		electron.ipcRenderer
			.send('statsRegister', options.conkieStatsModules)
	});
	$timeout(function() {
		electron.ipcRenderer
			.send('statsSettings', options.conkieStats);
	});
	// }}}
	// Position the widget {{{
	$timeout(function() {
		electron.ipcRenderer
			.send('setPosition', options.window);
	});
	// }}}
	// Periodically clean up redundent data for all charts {{{
	var cleaner = function() {
		console.log('Beginning data clean');
		var cleanStartTime = Date.now();
		var cleanTo = Date.now() - options.chartPeriod;
		_.forEach($scope.charts, function(chart, chartId) {
			// Shift all data if the date has fallen off the observed time range
			var beforeLength = chart.data.length;
			chart.data = _.dropWhile(chart.data, function(d) {
				return (d[0] < cleanTo);
			});
			console.log('Cleaned charts.' + chartId + ' from length=' + beforeLength + ' now=' + chart.data.length);
		});
		console.log('End data clean. Time taken =' + (Date.now() - cleanStartTime) + 'ms');
		$timeout(cleaner, options.chartPeriodCleanup);
	};
	$timeout(cleaner, options.chartPeriodCleanup);
	// }}}
	// }}}

	// .time {{{
	$interval(function() {
		$scope.time = moment().format('HH:mm');
	}, 1000);
	// }}}

	// Charts {{{
	$scope.charts = {};
	$scope.charts.template = {
		config: {
			width: 150,
			height: 33,
			lineColor: '#FFF',
			fillColor: '#CCC',
		},
	};

	$scope.charts.battery = _.defaultsDeep({
		data: [],
		config: $scope.charts.template.config,
	});

	$scope.charts.memory = {
		data: [],
		config: $scope.charts.template.config,
	};

	$scope.charts.cpu = {
		data: [],
		config: $scope.charts.template.config,
	};

	$scope.charts.io = {
		data: [],
		config: $scope.charts.template.config,
	};
	// }}}

	console.log('Theme controller loaded');
});
