import { describe, expect, test } from 'vitest';
import { matchUriTemplate } from './util.js';

describe('matchUriTemplate', () => {
  test('should match a URI template and extract parameters', () => {
    const uri = 'http://example.com/users/123';
    const templates = ['http://example.com/users/{userId}'];

    const result = matchUriTemplate(uri, templates);

    expect(result).toEqual({
      uri: 'http://example.com/users/{userId}',
      params: { userId: '123' },
    });
  });

  test('should return undefined if no template matches', () => {
    const uri = 'http://example.com/users/123';
    const templates = ['http://example.com/posts/{postId}'];

    const result = matchUriTemplate(uri, templates);

    expect(result).toBeUndefined();
  });

  test('should match the correct template when multiple templates are provided', () => {
    const uri = 'http://example.com/posts/456/comments/789';
    const templates = [
      'http://example.com/users/{userId}',
      'http://example.com/posts/{postId}/comments/{commentId}',
    ];

    const result = matchUriTemplate(uri, templates);

    expect(result).toEqual({
      uri: 'http://example.com/posts/{postId}/comments/{commentId}',
      params: { postId: '456', commentId: '789' },
    });
  });

  test('should handle templates with multiple parameters', () => {
    const uri = 'http://example.com/users/123/orders/456';
    const templates = ['http://example.com/users/{userId}/orders/{orderId}'];

    const result = matchUriTemplate(uri, templates);

    expect(result).toEqual({
      uri: 'http://example.com/users/{userId}/orders/{orderId}',
      params: { userId: '123', orderId: '456' },
    });
  });

  test('should return undefined if the URI segments do not match the template segments', () => {
    const uri = 'http://example.com/users/123/orders';
    const templates = ['http://example.com/users/{userId}/orders/{orderId}'];

    const result = matchUriTemplate(uri, templates);

    expect(result).toBeUndefined();
  });

  test('should not match when a URI segment is empty', () => {
    const templates = ['my-scheme:///schemas/{schema}'];

    expect(
      matchUriTemplate('my-scheme:///schemas/', templates)
    ).toBeUndefined();
  });

  test('should not skip literal segments after an empty segment', () => {
    const templates = ['my-scheme:///users/{userId}/posts'];

    expect(
      matchUriTemplate('my-scheme:///users//comments', templates)
    ).toBeUndefined();
  });
});
