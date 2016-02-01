/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */
import httpError from 'http-errors';
import { formatError } from 'graphql/error';
import { execute } from 'graphql/execution';
import { parse, Source } from 'graphql/language';
import { validate } from 'graphql/validation';
import { getOperationAST } from 'graphql/utilities/getOperationAST';
import { parseBody } from './parseBody';
import { renderGraphiQL } from './renderGraphiQL';
import accepts from "accepts";

import type { IncomingMessage, ServerResponse } from './flow/http';

/**
 * Used to configure the graphQLHTTP middleware by providing a schema
 * and other configuration options.
 */
export type Options = ((req: Request) => OptionsObj) | OptionsObj
export type OptionsObj = {
  /**
   * A GraphQL schema from graphql-js.
   */
  schema: Object,

  /**
   * An object to pass as the rootValue to the graphql() function.
   */
  rootValue?: ?Object,

  /**
   * A boolean to configure whether the output should be pretty-printed.
   */
  pretty?: ?boolean,

  /**
   * A boolean to optionally enable GraphiQL mode
   */
  graphiql?: ?boolean,
};

export default function graphqlHTTP(options: Options): (req: IncomingMessage, res: ServerResponse) => void {
  if (!options) {
    throw new Error('GraphQL middleware requires options.');
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    // Higher scoped variables are referred to at various stages in the
    // asyncronous state machine below.
    let schema;
    let rootValue;
    let pretty;
    let graphiql;
    let showGraphiQL;
    let query;
    let variables;
    let operationName;

    // Use promises as a mechanism for capturing any thrown errors during the
    // asyncronous process.
    new Promise((resolve, reject) => {

      // Get GraphQL options given this request.
      const optionsObj = getOptions(options, req);
      schema = optionsObj.schema;
      rootValue = optionsObj.rootValue;
      pretty = optionsObj.pretty;
      graphiql = optionsObj.graphiql;

      // GraphQL HTTP only supports GET and POST methods.
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw httpError(405, 'GraphQL only supports GET and POST requests.');
      }

      // Parse the Request body.
      parseBody(req, (parseError, data) => {
        if (parseError) { reject(parseError); } else { resolve(data || {}); }
      });
    }).then(data => {
      showGraphiQL = graphiql && canDisplayGraphiQL(req, data);

      // Get GraphQL params from the request and POST body data.
      const params = getGraphQLParams(req, data);
      query = params.query;
      variables = params.variables;
      operationName = params.operationName;

      // If there is no query, but GraphiQL will be displayed, do not produce
      // a result, otherwise return a 400: Bad Request.
      if (!query) {
        if (showGraphiQL) {
          return null;
        }
        throw httpError(400, 'Must provide query string.');
      }

      // GraphQL source.
      const source = new Source(query, 'GraphQL request');

      // Parse source to AST, reporting any syntax error.
      let documentAST;
      try {
        documentAST = parse(source);
      } catch (syntaxError) {
        // Return 400: Bad Request if any syntax errors errors exist.
        res.statusCode = 400;
        return { errors: [ syntaxError ] };
      }

      // Validate AST, reporting any errors.
      const validationErrors = validate(schema, documentAST);
      if (validationErrors.length > 0) {
        // Return 400: Bad Request if any validation errors exist.
        res.statusCode = 400;
        return { errors: validationErrors };
      }

      // Only query operations are allowed on GET requests.
      if (req.method === 'GET') {
        // Determine if this GET request will perform a non-query.
        const operationAST = getOperationAST(documentAST, operationName);
        if (operationAST && operationAST.operation !== 'query') {
          // If GraphiQL can be shown, do not perform this query, but
          // provide it to GraphiQL so that the requester may perform it
          // themselves if desired.
          if (showGraphiQL) {
            return null;
          }

          // Otherwise, report a 405: Method Not Allowed error.
          res.setHeader('Allow', 'POST');
          throw httpError(
            405,
            `Can only perform a ${operationAST.operation} operation ` +
            `from a POST request.`
          );
        }
      }

      // Perform the execution, reporting any errors creating the context.
      try {
        return execute(
          schema,
          documentAST,
          rootValue,
          variables,
          operationName
        );
      } catch (contextError) {
        // Return 400: Bad Request if any execution context errors exist.
        res.statusCode = 400;
        return { errors: [ contextError ] };
      }
    }).catch(error => {
      // If an error was caught, report the httpError status, or 500.
      res.statusCode = error.status || 500;
      return { errors: [ error ] };
    }).then(result => {
      // Format any encountered errors.
      if (result && result.errors) {
        result.errors = result.errors.map(formatError);
      }

      // If allowed to show GraphiQL, present it instead of JSON.
      if (showGraphiQL) {
        res.setHeader('content-type', 'text/html');
        res.end(renderGraphiQL({ query, variables, result }));
      } else {
        // Otherwise, present JSON directly.
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result, null, pretty ? 2 : 0));
      }
    });
  };
}

/**
 * Get the options that the middleware was configured with, sanity
 * checking them.
 */
function getOptions(options: Options, req: IncomingMessage): OptionsObj {
  var optionsData = typeof options === 'function' ? options(req) : options;

  if (!optionsData || typeof optionsData !== 'object') {
    throw new Error(
      'GraphQL middleware option function must return an options object.'
    );
  }

  if (!optionsData.schema) {
    throw new Error(
      'GraphQL middleware options must contain a schema.'
    );
  }

  return optionsData;
}

type GraphQLParams = {
  query: ?string;
  variables: ?Object;
  operationName: ?string;
}

/**
 * Helper function to get the GraphQL params from the request.
 */
function getGraphQLParams(req: IncomingMessage, data: Object): GraphQLParams {
  // GraphQL Query string.
  var query = req.query.query || data.query;

  // Parse the variables if needed.
  var variables = req.query.variables || data.variables;
  if (variables && typeof variables === 'string') {
    try {
      variables = JSON.parse(variables);
    } catch (error) {
      throw httpError(400, 'Variables are invalid JSON.');
    }
  }

  // Name of GraphQL operation to execute.
  var operationName = req.query.operationName || data.operationName;

  return { query, variables, operationName };
}

/**
 * Helper function to determine if GraphiQL can be displayed.
 */
function canDisplayGraphiQL(req: IncomingMessage, data: Object): boolean {
  // If `raw` exists, GraphiQL mode is not enabled.
  var raw = req.query.raw !== undefined || data.raw !== undefined;
  // Allowed to show GraphiQL if not requested as raw and this request
  // prefers HTML over JSON.
  var accept = accepts(req);
  return !raw && accept.types([ 'json', 'html' ]) === 'html';
}
