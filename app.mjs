import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { Sequelize } from 'sequelize';

export default class TimescaleDBApp extends Homey.App {

  async onInit() {
    this.tableNameDevices = 'devices';
    this.tableNameVariables = 'variables';

    // Get Homey ID
    this.homeyId = await this.homey.cloud.getHomeyId();

    // Initialize Homey API
    this.homeyApi = await HomeyAPI.createAppAPI({
      homey: this.homey,
    });

    // Connect to ManagerDevices
    await this.homeyApi.devices.connect();

    // Initialize all Devices
    const devices = await this.homeyApi.devices.getDevices();
    for (const device of Object.values(devices)) {
      this.__initDevice(device);
    }

    // Initialize new Devices
    this.homeyApi.devices.on('device.create', device => {
      this.__initDevice(device);
    });

    // Initialize all Variables
    await this.homeyApi.logic.connect();
    this.homeyApi.logic.on('variable.create', variable => {
      this.__onVariableChange(variable);
    });
    this.homeyApi.logic.on('variable.update', variable => {
      this.__onVariableChange(variable);
    });

    // Connect to TimescaleDB
    const uri = await this.getConfigURI();
    if (uri) {
      await this.__connect(uri);
    }

    // If this is the first time, create a Timeline notification to guide the user to the settings page.
    const timelineNotificationWelcomeCreated = !(await this.homey.settings.get('timelineNotificationWelcomeCreated'));
    if (timelineNotificationWelcomeCreated) {
      await this.homey.notifications.createNotification({
        excerpt: 'Welcome to TimescaleDB! Visit the app\'s settings to enter your server\'s URI.',
      });
      await this.homey.settings.set('timelineNotificationWelcomeCreated', true);
    }

    this.log('TimescaleDBApp has been initialized');
  }

  async getConfigURI() {
    return this.homey.settings.get('uri') ?? null;
  }

  async setConfigURI(uri) {
    await this.__disconnect();

    if (uri === '') {
      uri = null;
    }

    if (uri !== null) {
      if (!/^postgres:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/.test(uri)) {
        throw new Error('Invalid TimescaleDB URI format. Please use: postgres://user:pass@host:port/database');
      }

      await this.__connect(uri);
    }

    this.log('New URI:', uri);
    await this.homey.settings.set('uri', uri);
  }

  async __disconnect() {
    if (this.sequelize) {
      await this.sequelize.close();
      this.sequelize = null;
      this.table = null;
      this.log('Disconnected from previous TimescaleDB instance.');
    }
  }

  async __connect(uri) {
    this.sequelize = new Sequelize(uri, {
      dialect: 'postgres',
      protocol: 'postgres',
      logging: false,
      // dialectOptions: {
      //   ssl: {
      //     require: false,
      //     rejectUnauthorized: false,
      //   },
      // },
    });

    await this.sequelize.authenticate();
    this.log('Connected to TimescaleDB.');

    // Legacy — Check if a table named `homey` exists and if it has entries.
    // If so, use the table name 'homey' for devices.
    const [results] = await this.sequelize.query(`SELECT to_regclass('homey') AS exists;`);
    if (results[0].exists) {
      const [countResults] = await this.sequelize.query(`SELECT COUNT(*) AS count FROM homey;`);
      if (countResults[0].count > 0) {
        this.tableNameDevices = 'homey';
        this.log('Legacy table "homey" found with entries. Using "homey" as devices table.');
      }
    }

    // Create models
    this.tableDevices = this.sequelize.define('device', {
      homey_id: {
        type: Sequelize.STRING(24), // Homey ID
        primaryKey: true,
      },
      device_id: {
        type: Sequelize.STRING(36), // Device ID
        primaryKey: true,
      },
      capability_id: {
        type: Sequelize.STRING(1000), // Capability ID
        primaryKey: true,
      },
      time: {
        type: Sequelize.DATE,
        primaryKey: true,
      },
      value: {
        type: Sequelize.DECIMAL,
      },
    }, {
      tableName: this.tableNameDevices,
      timestamps: false,
    });

    this.tableVariables = this.sequelize.define('variable', {
      homey_id: {
        type: Sequelize.STRING(24), // Homey ID
        primaryKey: true,
      },
      variable_id: {
        type: Sequelize.STRING(36), // Variable ID
        primaryKey: true,
      },
      time: {
        type: Sequelize.DATE,
        primaryKey: true,
      },
      value: {
        type: Sequelize.DECIMAL,
      },
    }, {
      tableName: this.tableNameVariables,
      timestamps: false,
    });

    // Ensure table exists
    await this.tableDevices.sync();
    await this.tableVariables.sync();
    this.log('Tables are ready.');

    // Devices — Enable Hypertable and Compression
    await Promise.resolve().then(async () => {
      // Ensure table is a HyperTable
      await this.sequelize
        .query(`SELECT create_hypertable('${this.tableNameDevices}', 'time', if_not_exists => TRUE);`)
        .catch((err) => { throw new Error(`Error Creating Hypertable: ${err.message}`); });

      // Enable Compression
      await this.sequelize
        .query(`ALTER TABLE ${this.tableNameDevices} SET (timescaledb.compress, timescaledb.compress_segmentby = 'homey_id, device_id, capability_id');`)
        .catch(err => { throw new Error(`Error Enabling Compression: ${err.message}`); });

      await this.sequelize
        .query(`SELECT add_compression_policy('${this.tableNameDevices}', INTERVAL '7 days', if_not_exists => TRUE);`)
        .catch(err => { throw new Error(`Error Adding Compression Policy: ${err.message}`); });
    })
      .then(() => this.log('Compression enabled on Devices table.'))
      .catch(err => this.error(`Error setting up Hypertable: ${err.message}`));

    // Variables — Enable Hypertable and Compression
    await Promise.resolve().then(async () => {
      // Ensure table is a HyperTable
      await this.sequelize
        .query(`SELECT create_hypertable('${this.tableNameVariables}', 'time', if_not_exists => TRUE);`)
        .catch((err) => { throw new Error(`Error Creating Hypertable: ${err.message}`); });

      // Enable Compression
      await this.sequelize
        .query(`ALTER TABLE ${this.tableNameVariables} SET (timescaledb.compress, timescaledb.compress_segmentby = 'homey_id, variable_id');`)
        .catch(err => { throw new Error(`Error Enabling Compression: ${err.message}`); });

      await this.sequelize
        .query(`SELECT add_compression_policy('${this.tableNameVariables}', INTERVAL '7 days', if_not_exists => TRUE);`)
        .catch(err => { throw new Error(`Error Adding Compression Policy: ${err.message}`); });
    })
      .then(() => this.log('Compression enabled on Variables table.'))
      .catch(err => this.error(`Error setting up Hypertable: ${err.message}`));
  }

  __initDevice(device) {
    const deviceId = device.id;
    Promise.resolve().then(async () => {
      await device.connect();

      device.on('capability', ({ capabilityId, value }) => {
        this.log(`[Device:${deviceId}][Capability:${capabilityId}] Changed to ${value}`);

        if (typeof value === 'boolean') {
          value = value ? 1 : 0;
        }

        if (typeof value !== 'number') {
          return;
        }

        if (this.tableDevices) {
          this.tableDevices.create({
            homey_id: this.homeyId,
            device_id: deviceId,
            capability_id: capabilityId,
            value,
            time: new Date().getTime(),
          }).catch(err => this.error(`Error inserting Device Entry: ${err}`));
        }
      });
    })
      .then(() => this.log(`[Device:${deviceId}] Initialized`))
      .catch(err => this.error(`[Device:${deviceId}] Error Initializing: ${err}`));
  }

  __onVariableChange(variable) {
    const variableId = variable.id;
    let value = variable.value;

    if (variable.type === 'boolean') {
      value = value ? 1 : 0;
    }

    if (typeof value !== 'number') {
      return;
    }

    if (this.tableVariables) {
      this.tableVariables.create({
        homey_id: this.homeyId,
        variable_id: variableId,
        value,
        time: new Date().getTime(),
      }).catch(err => this.error(`Error inserting Variable Entry: ${err}`));
    }
  }

};
