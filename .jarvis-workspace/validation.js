const Joi = require('joi');

const itemSchema = Joi.object({
  name: Joi.string().min(3).required(),
});

module.exports = itemSchema;
